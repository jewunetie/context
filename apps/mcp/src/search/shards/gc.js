/**
 * Garbage collection of unreferenced v3 shard revisions (CONTRACT-v3.md
 * "Collecting revisions", ruling OPEN-59).
 *
 * Revisions are content addressed and never rewritten, so every superseded
 * shard and every revision a losing pass wrote stays behind. Each call looks at
 * one page of the listing and deletes a revision only when all of these hold:
 *
 * - its key is under `.context/search/v3/shards/` and has the revision name
 *   shape (nothing else is ever listed or deleted);
 * - the current manifest does not name it;
 * - its listed `uploaded` time is known and older than the retention window
 *   (an unknown time, such as the epoch 0 S3 reports for a missing header, is
 *   not old);
 * - it is not protected as recently superseded (below).
 *
 * **Retention runs from supersession, not upload.** A reader that pinned a
 * manifest seconds before a new one replaced it may still read every revision
 * the old one names, however long ago they were uploaded. So the state object
 * (`GC_STATE_KEY`) remembers the keys the manifest named when a pass last
 * looked (`current`). When the next pass finds a different set, it records
 * `{ at: now, after: observedAt, keys: <the old set> }` in `retained`: those
 * keys, and any unreferenced revision uploaded after `observedAt` (a manifest
 * that came and went between two passes), are kept until a window has passed
 * since `at`. A pass with no valid state has no idea what was current before
 * it, so it protects everything for one window (`after: 0`) and deletes
 * nothing.
 *
 * **Progress is stored, not assumed.** Through `withLogicalDelete` a delete
 * leaves a tombstone that stays in the provider's listing, and any run of kept
 * keys at the front would also pin a cursor-less pass to the same first page.
 * The state object therefore keeps the listing cursor between passes; a
 * completed listing clears it, which wraps the next pass to the start. The
 * object lives beside, not under, the shard prefix. It is read from the bucket,
 * so `readState` accepts only the exact shape and bounds written here and
 * treats anything else as no state (which only delays deletion).
 *
 * Deletes go through `store.delete`, which in a gateway store is the
 * logical-delete wrapper. `putShard` (revisions.js) therefore never trusts a
 * refused create-only put without `exists`.
 */

import { SEARCH_PREFIX } from "../../../../../packages/shared/src/storageLayout.cjs";
import { V3_SHARD_PREFIX } from "./constants.js";
import { V3_LAYOUT } from "./io.js";

// lean: 15 minutes is well past any Worker request's wall time, so an in-flight
// reader that pinned the previous manifest still finds its revisions; raise it
// if a reader is ever allowed to hold a manifest longer.
export const REVISION_RETENTION_MS = 15 * 60 * 1000;

/** Store ops a collection pass leaves untouched, and the gate maintenance applies. */
export const GC_BUDGET_FLOOR = 2;

/** One listing page per call; the cursor to the next one is stored in the state. */
export const GC_PAGE_LIMIT = 200;

/** Collector state: cursor, what was current, what was recently superseded. */
export const GC_STATE_KEY = `${SEARCH_PREFIX}v3/gc.json`;

// Bounds on what `readState` accepts: a manifest names at most 64 revisions
// (MAX_SHARD_COUNT), and `retained` entries older than a window are dropped, so
// a state this code wrote is always inside them.
const MAX_KEYS = 512;
const MAX_RETAINED = 8;
const MAX_CURSOR = 1024;

const REVISION_NAME = /^\d{3}-[0-9a-f]{16}\.json$/;

function isRevisionKey(key) {
  return typeof key === "string" && key.startsWith(V3_SHARD_PREFIX) && REVISION_NAME.test(key.slice(V3_SHARD_PREFIX.length));
}

/** Upload time in ms, or null where the listing gives no usable time. */
function uploadedMs(uploaded) {
  const at = uploaded instanceof Date ? uploaded.getTime() : typeof uploaded === "string" ? Date.parse(uploaded) : uploaded;
  return Number.isFinite(at) && at > 0 ? at : null;
}

const isKeyList = (value) => Array.isArray(value) && value.length <= MAX_KEYS && value.every(isRevisionKey);
const isTime = (value) => Number.isFinite(value) && value >= 0;

/** The stored state, or null for anything that is not exactly what `collect` writes. */
function readState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return null;
  }
  if (!state || state.version !== 1 || !isTime(state.observedAt) || !isKeyList(state.current)) return null;
  if (!Array.isArray(state.retained) || state.retained.length > MAX_RETAINED) return null;
  for (const entry of state.retained) {
    if (!entry || !isTime(entry.at) || !isTime(entry.after) || !isKeyList(entry.keys)) return null;
  }
  const cursor =
    typeof state.cursor === "string" && state.cursor.length <= MAX_CURSOR && !/[\u0000-\u001f\u007f]/.test(state.cursor)
      ? state.cursor
      : undefined;
  return { observedAt: state.observedAt, current: state.current, retained: state.retained, cursor };
}

/** Entries still inside their window, plus the one this observation adds. */
function retainedAt(state, current, now) {
  const kept = (state?.retained || []).filter((entry) => now - entry.at < REVISION_RETENTION_MS);
  if (!state) kept.push({ at: now, after: 0, keys: [] });
  else if (state.current.length !== current.length || state.current.some((key, i) => key !== current[i])) {
    kept.push({ at: now, after: state.observedAt, keys: state.current });
  }
  if (kept.length <= MAX_RETAINED) return kept;
  // Never drop protection: fold the oldest entries into one that is later and
  // wider than all of them.
  const [first, ...rest] = kept.slice(0, kept.length - MAX_RETAINED + 1);
  const folded = rest.reduce(
    (all, entry) => ({ at: Math.max(all.at, entry.at), after: Math.min(all.after, entry.after), keys: [...new Set([...all.keys, ...entry.keys])] }),
    first
  );
  return [{ ...folded, keys: folded.keys.slice(0, MAX_KEYS) }, ...kept.slice(kept.length - MAX_RETAINED + 1)];
}

/**
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof import("../maintain.js").createSearchBudget>} budget
 * @param {{ manifest: object, now?: number, reserve?: number }} options
 *   `manifest` is the current v3 manifest; without one (or with another
 *   layout) nothing is known to be referenced and nothing is read, listed or
 *   deleted. `reserve` is store ops the caller keeps for its own later work, on
 *   top of the floor.
 * @returns {Promise<{ deleted: number, kept: number, failed: number }>}
 *   One state read, one listing, one op per delete and one state write.
 */
export async function collectShardRevisions(store, budget, { manifest, now = Date.now(), reserve = 0 } = {}) {
  const report = { deleted: 0, kept: 0, failed: 0 };
  if (!manifest || manifest.layout !== V3_LAYOUT || !Array.isArray(manifest.shards)) return report;
  const floor = GC_BUDGET_FLOOR + reserve;
  if (!budget.take(floor)) return report;
  const stored = await store.get(GC_STATE_KEY);
  const state = stored ? readState(await stored.text()) : null;

  const current = [...new Set(manifest.shards.filter(Boolean).map((entry) => entry.key))].filter(isRevisionKey).sort();
  const referenced = new Set(manifest.shards.filter(Boolean).map((entry) => entry.key));
  const retained = retainedAt(state, current, now);
  const protectedKeys = new Set(retained.flatMap((entry) => entry.keys));
  const newestAfter = retained.map((entry) => entry.after);

  if (!budget.take(floor)) return report;
  let cursor = state?.cursor;
  let page;
  try {
    page = await store.list({ prefix: V3_SHARD_PREFIX, cursor, limit: GC_PAGE_LIMIT });
  } catch (error) {
    // A cursor the provider no longer accepts restarts the listing.
    if (cursor === undefined || !budget.take(floor)) throw error;
    cursor = undefined;
    page = await store.list({ prefix: V3_SHARD_PREFIX, limit: GC_PAGE_LIMIT });
  }

  let finished = true;
  for (const object of page.objects || []) {
    const at = uploadedMs(object.uploaded);
    if (
      !isRevisionKey(object.key) ||
      referenced.has(object.key) ||
      protectedKeys.has(object.key) ||
      at === null ||
      now - at <= REVISION_RETENTION_MS ||
      newestAfter.some((after) => at > after)
    ) {
      report.kept += 1;
      continue;
    }
    // One more than the floor: the state write below must still fit.
    if (!budget.take(floor + 1)) {
      finished = false;
      break;
    }
    try {
      await store.delete(object.key);
      report.deleted += 1;
    } catch {
      report.failed += 1;
    }
  }

  // A page cut short by the budget is read again next time (its deleted keys
  // are no longer listed or are tombstoned); a finished one moves on.
  const next = !finished ? cursor : page.truncated && page.cursor ? page.cursor : undefined;
  if (budget.take(floor)) {
    await store.put(GC_STATE_KEY, JSON.stringify({ version: 1, observedAt: now, current, retained, ...(next ? { cursor: next } : {}) }));
  }
  return report;
}
