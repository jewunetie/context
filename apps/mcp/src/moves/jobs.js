/**
 * Logical folder-move jobs: their keys, the active-move sentinel, and the
 * overlay that makes a half-materialized move read as finished. Owns
 * `LOGICAL_MOVE_WORKSPACES`, the per-isolate hint that a workspace may have a
 * move in flight. Moved verbatim out of `src/index.js`.
 */

import { budgetedStore } from "../search/budget.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys } from "../notes/storage.js";
import { MOVE_JOB_PREFIX, MOVE_JOB_VERSION, MOVE_SENTINEL_KEY } from "./limits.js";

/** Counts only: never forward a marker's paths or provider text to the control plane. */
export function moveProgressFromText(text) {
  const found = /^(copied|deleted): (\d+)\/(\d+)$/m.exec(text);
  if (!found) return undefined;
  const completed = Number(found[2]);
  const total = Number(found[3]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0 || completed > total) {
    return undefined;
  }
  return {
    phase: found[1] === "copied" ? "copying" : "deleting",
    completed,
    total,
  };
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

function movedDestinationFor(job, sourceKey) {
  const item = (job.objects || []).find((entry) => entry.source === sourceKey);
  return item?.destination || null;
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
    ["logical_active", "copying", "deleting", "needs_cleanup"].includes(job.status)
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

/** Active move jobs; `[]` when the state cannot be read. Only for callers that never serve text on `[]`. */
export async function loadMoveJobs(store) {
  return (await loadMoveJobsOrNull(store)) ?? [];
}

/**
 * Active move jobs, or null when any marker cannot be read as an inactive one
 * or the listing fails (OPEN-25: fail closed). Every marker is read, whatever
 * the sentinel says, so the answer is the set of jobs read_note's overlay
 * (`loadMoveJobs`) sees; the sentinel is only `searchMoveJobs`' hint. A
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
  const out = new Map();
  for (const object of keys) {
    let hidden = false;
    for (const job of jobs) {
      const destination = movedDestinationFor(job, object.key);
      if (destination !== null) {
        hidden = true;
        out.set(destination, { ...object, key: destination, logicalSource: object.key });
        break;
      }
    }
    if (!hidden && !out.has(object.key)) out.set(object.key, object);
  }
  return [...out.values()];
}

export async function pathUnderActiveMovedSource(store, path) {
  const jobs = await loadMoveJobs(store);
  return jobs.some((job) => noteUnderPrefix(path, job.source));
}

/**
 * Write a move job's progress, unless the stored job is already finished. A
 * finished move (tombstoned, or no longer active) is a fence: a stale
 * materializer pass that read the job earlier must not put an older state over
 * it and bring the move back. The write is conditional on the stored version
 * where the store supports it, so a job finished between the check and the put
 * is not overwritten either. Returns whether the job was written.
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
  job.updated_at = new Date().toISOString();
  const onlyIf = store.capabilities?.conditionalWrite === true && stored.etag ? { onlyIf: { etagMatches: stored.etag } } : undefined;
  return Boolean(await store.put(key, JSON.stringify(job, null, 2), onlyIf));
}
