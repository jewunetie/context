/**
 * Logical folder-move jobs: their keys, the active-move sentinel, and the
 * overlay that makes a half-materialized move read as finished. Owns
 * `LOGICAL_MOVE_WORKSPACES`, the per-isolate hint that a workspace may have a
 * move in flight. Moved verbatim out of `src/index.js`.
 */

import { budgetedStore } from "../search/budget.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys } from "../notes/storage.js";
import { MOVE_JOB_PREFIX, MOVE_JOB_VERSION, MOVE_RECLAIM_PER_PASS, MOVE_SENTINEL_KEY } from "./limits.js";

/** Counts only: never forward a marker's paths or provider text to the control plane. */
export function moveProgressFromText(text) {
  const found = /^(copied|deleted|references): (\d+)\/(\d+)$/m.exec(text);
  if (!found) return undefined;
  const completed = Number(found[2]);
  const total = Number(found[3]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0 || completed > total) {
    return undefined;
  }
  return {
    phase: found[1] === "copied" ? "copying" : found[1] === "deleted" ? "deleting" : "rewriting",
    completed,
    total,
  };
}
/**
 * A move's failure text, with the bucket's paths taken out, for the control
 * plane's `gatewayJobs.lastError`.
 *
 * `moveProgressFromText` above states the rule for the other channel out of
 * the same consumer — counts only, never a marker's paths or provider text —
 * and keeps it with a strict integer regex. The failure channel forwarded the
 * tool's whole text, and a dozen of `materialize.js`'s throws interpolate
 * `pair.source` or `pair.destination`, so a customer's note path left the
 * bucket and was stored where the control plane only truncates it.
 * `safeMoveStorageDetail` says the same of its own fragment: "only in the
 * immediate tool response; never persist it in the move marker, activity or
 * gateway job status."
 *
 * Only a validated move id and a known stage survive. Redacting path-like
 * substrings from arbitrary provider text leaves filename fragments when a
 * path contains spaces or non-ASCII characters.
 */
export function moveErrorForControlPlane(text) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const id = /^move (move-[a-z0-9-]{8,80}):/i.exec(text)?.[1];
  if (!id) return "move job failed";
  const materialization = /^move move-[a-z0-9-]{8,80}: materialization paused: (copying|deleting|rewriting|inventorying)\b/i.exec(text);
  const reference = /^move move-[a-z0-9-]{8,80}: reference (rewrite|inventory) paused:/i.exec(text);
  const stage = materialization?.[1]?.toLowerCase() ||
    (reference?.[1] === "rewrite" ? "rewriting" : reference?.[1] === "inventory" ? "inventorying" : null);
  return `move job failed: ${id}${stage ? ` (${stage})` : ""}`;
}

const LOGICAL_MOVE_WORKSPACES = new Set();

/**
 * Finished moves leave a logical-delete tombstone under `.context/moves/` that
 * nothing removes. Listing it as the wrapper does by default reads every one,
 * so a request's cost grew by one subrequest per move ever made. A marker
 * written here is a pretty-printed job, several times the size of a tombstone,
 * so the listing drops tombstones by size and the cost is the live markers plus
 * one listing page per thousand keys.
 */
const MARKER_LISTING = { tombstonesBySize: true };

export function moveJobKey(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{12,80}$/i.test(id)) return null;
  return `${MOVE_JOB_PREFIX}${id}.json`;
}

export function noteUnderPrefix(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function movedSourceFor(job, destinationKey) {
  const item = (job.objects || []).find((entry) => entry.destination === destinationKey);
  return item?.source || null;
}

/**
 * The overlay's whole decision for one path, apart from privacy: the sources
 * `path` is the logical destination of, newest move first, or null when `path`
 * lies under a moving source (it reads nothing until the move finishes). The
 * caller asks `canSee` of each source before serving it, and tries `path` then
 * the source. Shared by read_note and the console read so the two cannot
 * disagree about where a half-moved note lives.
 */
export function movedSourcesFor(jobs, path) {
  if (jobs.some((job) => path.startsWith(`${job.source}/`))) return null;
  const sources = [];
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const source = movedSourceFor(jobs[index], path);
    if (source) sources.push(source);
  }
  return sources;
}

export function moveJobActive(job) {
  return (
    job &&
    job.version === MOVE_JOB_VERSION &&
    typeof job.id === "string" &&
    typeof job.source === "string" &&
    typeof job.destination === "string" &&
    Array.isArray(job.objects) &&
    ["logical_active", "copying", "deleting", "needs_cleanup", "rewriting"].includes(job.status)
  );
}

/**
 * Active move jobs, or null when the move state cannot be read (the listing or
 * a marker read throws). A caller that would serve note text must fail closed
 * on null: an unreadable move state is "moving or unknown", never "no moves".
 * A marker that reads but does not parse is a damaged marker and is skipped, as
 * before; the materializer reports the real failure when asked for that id.
 */
export async function loadMoveJobsOrNull(store) {
  const jobs = [];
  try {
    for (const { key } of await listAllKeys(store, MOVE_JOB_PREFIX, MARKER_LISTING)) {
      if (!key.endsWith(".json")) continue;
      const object = await getWithLegacyFallback(store, key);
      if (!object) continue;
      const text = await object.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (moveJobActive(parsed)) jobs.push(parsed);
    }
  } catch {
    return null;
  }
  return jobs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

/**
 * Active move jobs, or null when any marker cannot be read as an inactive one
 * or the listing fails (OPEN-25: fail closed). Every marker is read, whatever
 * the sentinel says, so the answer is the set of jobs read_note's overlay
 * (`loadMoveJobsOrNull`) sees; the sentinel is only `searchMoveJobs`' hint. A
 * finished move's marker is a logical-delete tombstone that is never removed;
 * the listing drops tombstones by size without reading them (`MARKER_LISTING`),
 * so history costs one listing page per thousand moves and nothing per move.
 */
export async function activeMoveJobsOrNull(store) {
  const jobs = [];
  try {
    for (const { key } of await listAllKeys(store, MOVE_JOB_PREFIX, MARKER_LISTING)) {
      if (!key.endsWith(".json")) continue;
      const object = await getWithLegacyFallback(store, key);
      if (!object) continue;
      const job = JSON.parse(await object.text());
      if (job?.version !== MOVE_JOB_VERSION) return null;
      if (moveJobActive(job)) jobs.push(job);
    }
  } catch {
    return null;
  }
  return jobs;
}

async function moveSentinelActive(store, budget = null) {
  try {
    const reader = budget ? budgetedStore(store, budget, 0) : store;
    return (await reader.get(MOVE_SENTINEL_KEY)) !== null;
  } catch {
    // Fail closed: a sentinel that cannot be read is a move that may be active.
    // The markers then decide, so a hint that errors never lets a moving note
    // through the index.
    return true;
  }
}

export async function writeMoveSentinel(store) {
  markLogicalMovesMaybeActive(store);
  await store.put(
    MOVE_SENTINEL_KEY,
    JSON.stringify({ version: MOVE_JOB_VERSION, active: true, updated_at: new Date().toISOString() })
  );
}

/**
 * Keep the sentinel only while a move may be active. It is removed only when
 * the markers read as none (never when they cannot be read), and, where the
 * store has conditional delete, only if it is still the sentinel read before
 * the markers were listed, so a move that starts meanwhile keeps its own.
 * The sentinel is a hint for `searchMoveJobs` only; nothing that withholds a
 * moving note depends on it (activeMoveJobsOrNull reads every marker).
 */
export async function refreshMoveSentinel(store) {
  let sentinel;
  try {
    sentinel = await store.get(MOVE_SENTINEL_KEY);
  } catch {
    sentinel = undefined;
  }
  const jobs = await activeMoveJobsOrNull(store);
  if (jobs === null) return [];
  if (jobs.length) {
    await writeMoveSentinel(store);
    return jobs;
  }
  if (sentinel === undefined) return jobs;
  if (sentinel) {
    const options = store.capabilities?.conditionalDelete === true && sentinel.etag ? { onlyIf: { etagMatches: sentinel.etag } } : undefined;
    const deleted = await deleteWithLegacyFallback(store, MOVE_SENTINEL_KEY, options).catch(() => null);
    if (deleted === null) return jobs;
  }
  clearLogicalMovesMaybeActive(store);
  return jobs;
}

function logicalMoveWorkspaceKey(store) {
  return store?.actor?.workspaceId || null;
}

function markLogicalMovesMaybeActive(store) {
  const key = logicalMoveWorkspaceKey(store);
  if (key) LOGICAL_MOVE_WORKSPACES.add(key);
}

function clearLogicalMovesMaybeActive(store) {
  const key = logicalMoveWorkspaceKey(store);
  if (key) LOGICAL_MOVE_WORKSPACES.delete(key);
}

/**
 * Active move jobs for a search, or null when the move state cannot be read:
 * the caller then treats a move as active and serves no note it cannot place.
 */
export async function searchMoveJobs(store, prefix, budget = null) {
  if (prefix) return loadMoveJobsOrNull(store);
  const key = logicalMoveWorkspaceKey(store);
  if (!key || (!LOGICAL_MOVE_WORKSPACES.has(key) && !(await moveSentinelActive(store, budget)))) return [];
  const jobs = await loadMoveJobsOrNull(store);
  if (jobs !== null && !jobs.length) await refreshMoveSentinel(store);
  return jobs;
}

export async function fallbackMoveJobs(store, prefix, budget = null) {
  return searchMoveJobs(store, prefix, budget);
}

export function applyMoveOverlay(keys, jobs) {
  if (!jobs.length) return keys;
  // A workspace can have thousands of notes and several thousand objects in
  // active moves. Looking through every job's object list for every listed
  // note made ordinary listings and orientation take minutes. Index the
  // source paths once, retaining the earliest job's precedence for a source.
  const destinations = new Map();
  for (const job of jobs) {
    for (const item of job.objects || []) {
      if (!destinations.has(item.source)) destinations.set(item.source, item.destination);
    }
  }
  const out = new Map();
  for (const object of keys) {
    const destination = destinations.get(object.key);
    if (destination) out.set(destination, { ...object, key: destination, logicalSource: object.key });
    else if (!out.has(object.key)) out.set(object.key, object);
  }
  return [...out.values()];
}

/** True when `path` is under a moving source, or when the move state cannot be read (fail closed: the write is refused as an active move is). */
export async function pathUnderActiveMovedSource(store, path) {
  const jobs = await loadMoveJobsOrNull(store);
  if (jobs === null) return true;
  return jobs.some((job) => noteUnderPrefix(path, job.source));
}

/**
 * Write a move job's progress, unless the stored job is finished or another
 * pass has advanced it. Returns whether the job was written; false means back
 * off (the next pass re-reads the stored job and carries on).
 *
 * Two fences. A finished move (tombstoned, absent, or no longer active) is
 * never written, so a stale pass cannot bring it back. And `job.generation` is
 * the generation the pass read: the stored job must still carry it, so a pass
 * that read the job before another pass advanced it cannot put its older state
 * over the newer one. A job written before this field existed counts as 0.
 *
 * The put is conditional on the stored version where the store supports it, so
 * a job advanced or finished between the check and the put is refused. Where it
 * does not (conditionalWrite false), the put is unconditional, so the pass
 * reads the job back and backs off when the stored text is not what it wrote;
 * a write landing between that read and the other pass's put can still win.
 * Progress is derived from the objects themselves on every pass, so a lost
 * write costs a repeated step, never a wrong state.
 */
export async function persistMoveJob(store, job) {
  const key = moveJobKey(job.id);
  const stored = await getWithLegacyFallback(store, key);
  if (!stored) return false;
  let current;
  try {
    current = JSON.parse(await stored.text());
  } catch {
    return false;
  }
  if (!moveJobActive(current)) return false;
  const generation = job.generation ?? 0;
  if ((current.generation ?? 0) !== generation) return false;
  const next = { ...job, generation: generation + 1, updated_at: new Date().toISOString() };
  const body = JSON.stringify(next, null, 2);
  const conditional = store.capabilities?.conditionalWrite === true && stored.etag;
  if (!(await store.put(key, body, conditional ? { onlyIf: { etagMatches: stored.etag } } : undefined))) return false;
  if (!conditional) {
    const back = await getWithLegacyFallback(store, key);
    if (!back || (await back.text()) !== body) return false;
  }
  job.generation = next.generation;
  job.updated_at = next.updated_at;
  return true;
}

/**
 * Reclaim finished moves' tombstones older than `olderThan` (ms), at most
 * MOVE_RECLAIM_PER_PASS, under `.context/moves/` only. Live markers (any
 * status), the sentinel and every other key are untouched: a candidate must be
 * marker-sized and read back as a tombstone. `take` charges the caller's budget.
 */
export async function reclaimMoveTombstones(store, { olderThan, take }) {
  if (typeof store?.reclaimTombstones !== "function") return 0;
  return store.reclaimTombstones(MOVE_JOB_PREFIX, { olderThan, limit: MOVE_RECLAIM_PER_PASS, take });
}
