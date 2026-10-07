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

export async function loadMoveJobs(store) {
  const jobs = [];
  let objects;
  try {
    objects = await listAllKeys(store, MOVE_JOB_PREFIX);
  } catch {
    return jobs;
  }
  for (const { key } of objects) {
    if (!key.endsWith(".json")) continue;
    try {
      const object = await getWithLegacyFallback(store, key);
      if (!object) continue;
      const parsed = JSON.parse(await object.text());
      if (moveJobActive(parsed)) jobs.push(parsed);
    } catch {
      // A damaged move marker is not allowed to break ordinary reads. The
      // materializer will report the real failure when asked for that id.
    }
  }
  return jobs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

/**
 * Active move jobs, or null when any marker cannot be read as an inactive one
 * or the listing fails (OPEN-25: fail closed). Every marker is read, whatever
 * the sentinel says, so the answer is the set of jobs read_note's overlay
 * (`loadMoveJobs`) sees; the sentinel is only `searchMoveJobs`' hint. A
 * finished move's marker is a logical-delete tombstone that is never removed,
 * so this costs one unbudgeted read per historical move, as read_note does.
 */
export async function activeMoveJobsOrNull(store) {
  const jobs = [];
  try {
    for (const { key } of await listAllKeys(store, MOVE_JOB_PREFIX)) {
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
    return false;
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

export async function searchMoveJobs(store, prefix, budget = null) {
  if (prefix) return loadMoveJobs(store);
  const key = logicalMoveWorkspaceKey(store);
  if (!key || (!LOGICAL_MOVE_WORKSPACES.has(key) && !(await moveSentinelActive(store, budget)))) return [];
  const jobs = await loadMoveJobs(store);
  if (!jobs.length) await refreshMoveSentinel(store);
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

export async function persistMoveJob(store, job) {
  job.updated_at = new Date().toISOString();
  await store.put(moveJobKey(job.id), JSON.stringify(job, null, 2));
}
