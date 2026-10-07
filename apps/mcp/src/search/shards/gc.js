/**
 * Garbage collection of unreferenced v3 shard revisions (CONTRACT-v3.md
 * "Collecting revisions", ruling OPEN-59).
 *
 * Revisions are content addressed and never rewritten, so every superseded
 * shard and every revision a losing pass wrote stays behind. This collects one
 * page of them per call. A revision is deleted only when all of these hold:
 *
 * - its key is under `.context/search/v3/shards/` and has the revision name
 *   shape (nothing else is ever listed or deleted);
 * - the current manifest does not name it;
 * - its listed `uploaded` time is known and older than the retention window.
 *
 * The window stands in for "retained manifests": a reader pinned to the
 * previous manifest finishes within it, so every revision that manifest named
 * is still stored. A listing with no usable `uploaded` (S3 reports epoch 0 for
 * a missing header) is kept, because unknown age is not old.
 *
 * Deletes go through `store.delete`, which in a gateway store is the
 * logical-delete wrapper and may leave a tombstone. `putShard` (revisions.js)
 * therefore never trusts a refused create-only put without `exists`.
 */

import { V3_SHARD_PREFIX } from "./constants.js";
import { V3_LAYOUT } from "./io.js";

// lean: 15 minutes is well past any Worker request's wall time, so an in-flight
// reader that pinned the previous manifest still finds its revisions; raise it
// if a reader is ever allowed to hold a manifest longer.
export const REVISION_RETENTION_MS = 15 * 60 * 1000;

/** Store ops a collection pass leaves untouched, and the gate maintenance applies. */
export const GC_BUDGET_FLOOR = 2;

// lean: one page per call and no stored cursor; deletes shrink the next first
// page, and at most 64 revisions (MAX_SHARD_COUNT) are referenced, so the page
// only stalls if 200 of its keys are all live or younger than the window.
export const GC_PAGE_LIMIT = 200;

const REVISION_NAME = /^\d{3}-[0-9a-f]{16}\.json$/;

function isRevisionKey(key) {
  return typeof key === "string" && key.startsWith(V3_SHARD_PREFIX) && REVISION_NAME.test(key.slice(V3_SHARD_PREFIX.length));
}

/** Milliseconds since upload, or null where the listing gives no usable time. */
function ageOf(uploaded, now) {
  const at = uploaded instanceof Date ? uploaded.getTime() : typeof uploaded === "string" ? Date.parse(uploaded) : uploaded;
  return Number.isFinite(at) && at > 0 ? now - at : null;
}

/**
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof import("../maintain.js").createSearchBudget>} budget
 * @param {{ manifest: object, now?: number, cursor?: string, reserve?: number }} options
 *   `reserve` is store ops the caller keeps for its own later work, on top of
 *   the floor. `manifest` is the current v3 manifest; without one (or with another layout)
 *   nothing is known to be referenced and nothing is listed or deleted.
 * @returns {Promise<{ deleted: number, kept: number, failed: number, cursor?: string }>}
 *   `cursor` is set when the listing has more pages.
 */
export async function collectShardRevisions(store, budget, { manifest, now = Date.now(), cursor, reserve = 0 } = {}) {
  const report = { deleted: 0, kept: 0, failed: 0 };
  if (!manifest || manifest.layout !== V3_LAYOUT || !Array.isArray(manifest.shards)) return report;
  const floor = GC_BUDGET_FLOOR + reserve;
  if (!budget.take(floor)) return report;
  const referenced = new Set(manifest.shards.filter(Boolean).map((entry) => entry.key));
  const page = await store.list({ prefix: V3_SHARD_PREFIX, cursor, limit: GC_PAGE_LIMIT });
  for (const object of page.objects || []) {
    const age = ageOf(object.uploaded, now);
    if (!isRevisionKey(object.key) || referenced.has(object.key) || age === null || age <= REVISION_RETENTION_MS) {
      report.kept += 1;
      continue;
    }
    if (!budget.take(floor)) break;
    try {
      await store.delete(object.key);
      report.deleted += 1;
    } catch {
      report.failed += 1;
    }
  }
  if (page.truncated && page.cursor) report.cursor = page.cursor;
  return report;
}
