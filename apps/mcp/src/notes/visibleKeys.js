/**
 * The notes a caller can see, with in-flight logical moves applied: listing
 * every note key, filtering it through `canSee`, and reading a note that may
 * still sit at its pre-move key.
 */

import {
  applyMoveOverlay,
  loadMoveJobsOrNull,
  movedSourcesFor,
  noteUnderPrefix,
} from "../moves/jobs.js";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys, listImmediateLayout, mapInBatches } from "./storage.js";

/** List note objects without traversing dot-prefixed history/audit/ACL plumbing. */
export async function listAllNoteKeys(store) {
  // A recursive delimiter walk made one or more list requests for every
  // contact/conversation directory. Large communication trees have thousands
  // of those directories, so a reference rewrite timed out before its first
  // note. Partition at the workspace root, then page each root in parallel:
  // the number of requests follows object pages rather than folder count.
  const layout = await listImmediateLayout(store);
  const branches = await mapInBatches(layout.prefixes, 8, (prefix) => listAllKeys(store, prefix));
  return [...layout.objects, ...branches.flat()].filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
}

/**
 * Visible note keys with moves applied, or null when the move state cannot be
 * read: any note could then be mid-move into or out of a hidden location, so
 * none is listed. The answer does not depend on what is hidden.
 */
export async function listVisibleNoteKeysWithMoves(store, scope, rules, overrides, prefix) {
  const jobs = await loadMoveJobsOrNull(store);
  if (jobs === null) return null;
  const raw = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  let keys = raw;
  if (prefix && jobs.some((job) => noteUnderPrefix(job.destination, prefix) || noteUnderPrefix(prefix, job.destination))) {
    const movedSources = await Promise.all(
      jobs
        .filter((job) => noteUnderPrefix(job.destination, prefix) || noteUnderPrefix(prefix, job.destination))
        .map((job) => listAllKeys(store, `${job.source}/`).catch(() => []))
    );
    keys = [...keys, ...movedSources.flat()];
  }
  return applyMoveOverlay(keys, jobs).filter(
    ({ key, logicalSource }) =>
      (!prefix || noteUnderPrefix(key, prefix)) &&
      key.endsWith(".md") &&
      !isPlumbing(key) &&
      canSee(key, scope, rules, overrides) &&
      (!logicalSource || canSee(logicalSource, scope, rules, overrides))
  );
}

/**
 * @param fetchOne how deep to look: the default fetches the object, and
 *   `probeWithLegacyFallback` answers the same question out of metadata. One
 *   function either way, because the ORDER these keys are tried in is the part
 *   that must not exist twice — see the rows about second implementations.
 */
export async function getVisibleMovedNote(store, scope, rules, overrides, path, fetchOne = getWithLegacyFallback) {
  const jobs = await loadMoveJobsOrNull(store);
  // Fail closed: an unreadable move state answers like a note that cannot be
  // read, and says nothing about why.
  if (jobs === null) return { object: null, physicalPath: path };
  // A path the caller cannot see is looked up exactly as a path that is not
  // there: one probe, whatever the moves say. Following a move into a hidden
  // destination costs a second probe (the source), which a team caller could
  // read as "something is moving here". The caller refuses the result anyway.
  if (!canSee(path, scope, rules, overrides)) {
    return { object: await fetchOne(store, path), physicalPath: path };
  }
  const sources = movedSourcesFor(jobs, path);
  if (sources === null) return { object: null, physicalPath: path };
  for (const source of sources) {
    if (!canSee(source, scope, rules, overrides)) return { object: null, physicalPath: path };
    const destinationObject = await fetchOne(store, path);
    if (destinationObject) return { object: destinationObject, physicalPath: path, logicalMove: true };
    const sourceObject = await fetchOne(store, source);
    if (sourceObject) return { object: sourceObject, physicalPath: source, logicalMove: true };
  }
  return { object: await fetchOne(store, path), physicalPath: path };
}
