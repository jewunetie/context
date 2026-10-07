// Which notes a move must re-read, from the link graph (Task 14, arch 11.1).
// `rewriteReferences` narrows its body reads to this list and keeps everything
// else it does; `null` means "scan every visible note", the answer whenever the
// graph cannot vouch for the result.
//
// Why a complete graph plus the top-up is enough. After a complete sweep every
// note listed by the census it started on (`coveredThrough`) has its links in
// the postings. A note that changed or moved since then carries a listing time
// at or after that census, so it is read whatever the postings say. That also
// covers a node left owing `reverseRepair` by a same-note projection race (the
// Task 7 window): a ready wrap means no swept node owed any, so one owing it now
// was projected after its sweep visit, by the write hook of a write within
// seconds of that projection, and the margin puts that write in the top-up
// (recorded in docs/decisions/link-graph.md with its ceiling). The postings
// describe stored bodies only, so every note with collaboration state is read
// too: its accepted text may never have reached the .md.
//
// Privacy: posting sources are filtered by `canSeeKey` before anything else, no
// node record is read (OPEN-24), and the result is intersected with the
// caller's visible listing, so a hidden note's body is never read and never
// counted.
import { graphHealth } from "../../graph/manifest.js";
import { graphView } from "../../graph/mode.js";
import { readPostings } from "../../graph/postings.js";
import { baseName } from "../../graph/facts.js";
import { nameHash, pathHash } from "../../graph/keys.js";
import { activeMoveJobsOrNull } from "../../moves/jobs.js";
import { supported as collaborationSupported } from "@context/collaboration";
import { createSearchBudget } from "../../search/maintain.js";
import { SEARCH_SUBREQUEST_BUDGET } from "../../search/visible.js";

// lean: fixed 10 minutes (OPEN-23) for provider listing clock versus census clock skew and a late write hook, measure skew on managed buckets before shrinking it
export const TOP_UP_MARGIN_MS = 10 * 60 * 1000;

// `HEAD_PREFIX` in packages/collaboration/src/storage.js (not exported); a
// head is `<sha256(path)>.json`, the same hash as the graph's `pathHash`.
const COLLABORATION_HEADS = ".context/collaboration/v1/heads/";
const HEAD_FILE = /^([0-9a-f]{64})\.json$/;

/**
 * Hashes of every path with collaboration state, one budgeted op per listing
 * page, or null when the budget or the listing cannot finish. A note with a
 * head may hold accepted text its .md (and so the graph) never saw, which the
 * scan reads through `generatedCollaborationBase`.
 */
async function collaborationHashes(view, budget) {
  const hashes = new Set();
  let cursor;
  do {
    if (!budget.take()) return null;
    const page = await view.list({ prefix: COLLABORATION_HEADS, cursor, limit: 1000 });
    for (const { key } of page.objects || []) {
      const m = typeof key === "string" && key.startsWith(COLLABORATION_HEADS) ? HEAD_FILE.exec(key.slice(COLLABORATION_HEADS.length)) : null;
      if (m) hashes.add(m[1]);
    }
    if (page.truncated && (!page.cursor || page.cursor === cursor)) return null;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return hashes;
}

/**
 * The visible keys a move must read, in listing order, or null to scan.
 *
 * @param store the request's store (graph reads run on `graphView` of it)
 * @param visibleListing `{ key, uploaded }[]`, already filtered by the caller's `canSee`
 * @param renames Map of pre-move path to post-move path
 * @param canSeeKey `(key) => boolean`, the caller's visibility rule
 * @returns {Promise<string[] | null>} never rejects
 */
export async function indexedReferrerKeys(store, { visibleListing, renames, canSeeKey }) {
  // Attachments have no `incoming/` postings (OPEN-5).
  for (const from of renames.keys()) if (!from.endsWith(".md")) return null;
  // A server-side copy may keep the source's listing time, so a note moved
  // since the sweep could miss the top-up. Gateway stores never copy (the
  // logical-delete wrapper and Dropbox declare false); a bare S3 store does.
  if (store.capabilities?.serverSideCopy === "same-store") return null;
  // WRITE_ENRICH_SUBREQUEST_BUDGET=0 is the graph's kill switch: postings are
  // frozen, so they cannot vouch for referrers (final review).
  if (store.writeEnrichBudget === 0) return null;
  try {
    const budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET);
    const view = graphView(store, budget);
    const health = await graphHealth(view, budget);
    if (!health.complete || !health.coveredThrough) return null;
    // Postings are keyed by physical paths; a logical move presents others (OPEN-25).
    if ((await activeMoveJobsOrNull(store))?.length !== 0) return null;

    const candidates = new Set(renames.values());
    for (const from of renames.keys()) {
      const lookups = [["incoming", await pathHash(from)], ["bare", await nameHash(baseName(from))]];
      for (const [family, hash] of lookups) {
        // OPEN-24: no node read per entry; the re-read body decides (arch 15.3).
        const { entries, complete } = await readPostings(view, budget, {
          gen: health.generation, family, hash, canSee: canSeeKey, validate: () => true,
        });
        if (!complete) return null;
        for (const { source } of entries) candidates.add(renames.get(source) ?? source);
      }
    }
    const collaborative = collaborationSupported(store) ? await collaborationHashes(view, budget) : new Set();
    if (!collaborative) return null;
    const since = Date.parse(health.coveredThrough) - TOP_UP_MARGIN_MS;
    for (const { key, uploaded } of visibleListing) {
      const at = uploaded ? new Date(uploaded).getTime() : NaN;
      // Missing, zero or unparseable: unknown, so read it.
      if (!(at > 0) || at >= since) candidates.add(key);
      else if (collaborative.size > 0 && collaborative.has(await pathHash(key))) candidates.add(key);
    }
    return visibleListing.map(({ key }) => key).filter((key) => candidates.has(key));
  } catch {
    return null; // a budget refusal inside the view, or any store failure
  }
}
