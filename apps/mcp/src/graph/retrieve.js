// Related-note candidates for one caller (arch 12.1 to 12.4, Task 16). One
// lexical query built from the seed's own text, the seed's graph
// neighbourhood (`neighbors.js`), merged by path with every reason kept and
// ranked by reciprocal rank fusion. Never throws: a part that fails is left
// out and the answer is labelled `possiblyIncomplete`.
//
// Privacy. Every part runs over what `canSeeKey` admits before anything is
// ranked or cut (arch 12.2 step 6). The parts run in a fixed order on the one
// budget: the catalog (a fixed two reads), then search, then the graph. Search
// goes before the graph because the graph's read count depends on hidden
// posting entries (OPEN-27): run first, it would hand search a remainder that
// varies with hidden data. Last, it can only lose its own families, all at
// once for a strict caller, which is the one bit docs/decisions/link-graph.md
// records. Workspace-level health and index freshness can flip with a hidden
// note's edit (OPEN-33); that changes labels and which rooted links resolve,
// never a path, count or rank derived from a hidden note.
import { isEncryptedNote } from "../encryption.js";
import { extractReferences, indexByName } from "../links.js";
import { extractFields } from "../search/indexer.js";
import { indexIsBehind, loadDocmapPaths } from "../search/shards.js";
import { tokenize, stem } from "../search/text.js";
import { searchIndexedNotes } from "../search/visible.js";
import { graphNeighbors } from "./neighbors.js";

// Experiment parameters (OPEN-31, arch 12.3), to be tuned in Phase 5.
export const RRF_K = 60;
export const NEARBY_DISTANCE = 2;
export const MAX_QUERY_TERMS = 12;
export const RESULT_LIMIT = 10;

const REASONS = ["links_here", "linked_from_here", "shares_target", "shares_url", "related_text", "nearby"];
const EXPLICIT = new Set(["links_here", "linked_from_here"]);
// Body words too common to say what a note is about; shorter ones are dropped by length.
const STOP = new Set("that this with from have were will would there their what when which about into than then them they been also some more such only other your just like over each must should could does".split(" "));

/** Arch 8.3: segments of A's and B's directories outside their common prefix. */
export function directoryDistance(a, b) {
  const da = a.split("/").slice(0, -1);
  const db = b.split("/").slice(0, -1);
  let common = 0;
  while (common < da.length && common < db.length && da[common] === db[common]) common += 1;
  return da.length + db.length - 2 * common;
}

/**
 * Up to MAX_QUERY_TERMS words from the seed's own text, deterministic: title,
 * then headings, then body words by frequency (ties by first occurrence).
 * For `link_suggestions` only the given sections: their headings, then their
 * text. Link and URL targets are blanked first: they are addresses, not
 * prose, and the graph already counts them. Raw tokens are emitted (the query
 * parser stems once), deduplicated on the stem.
 */
export function seedQuery(seed, intent) {
  const prose = (text) => {
    let out = String(text ?? "");
    for (const { start, end } of extractReferences(out)) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
    return out;
  };
  let title = "";
  let headings = "";
  let body = "";
  if (intent === "link_suggestions") {
    const sections = Array.isArray(seed.sections) ? seed.sections : [];
    headings = sections.map((s) => s?.heading ?? "").join("\n");
    body = prose(sections.map((s) => s?.text ?? "").join("\n"));
  } else {
    ({ title, headings, body } = extractFields(seed.path, prose(seed.body)));
  }
  const picked = new Map();
  const add = (token) => {
    const s = stem(token);
    if (picked.size < MAX_QUERY_TERMS && !picked.has(s)) picked.set(s, token);
  };
  for (const t of tokenize(title)) add(t);
  for (const t of tokenize(headings)) add(t);
  const counts = new Map();
  for (const t of tokenize(body)) if (t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  // Map order is first occurrence and sort is stable, so ties keep it.
  for (const [t] of [...counts].sort((a, b) => b[1] - a[1])) add(t);
  return [...picked.values()].join(" ");
}

// A channel-day hit is `<note>#<anchor>`; the relation is about the note.
const notePathOf = (key) => {
  const i = key.indexOf(".md#");
  return i >= 0 ? key.slice(0, i + 3) : key;
};
const byScoreThenPath = (map) => [...map].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).map(([p]) => p);

/**
 * `{ relations: { path, reasons, evidence? }[], unresolved, possiblyIncomplete }`
 * for `seed` (`{ path, body, sections? }`). `intent` is "related_notes" or
 * "link_suggestions". `scope` is the caller's scope, passed to graphNeighbors
 * (only exactly "private" keeps partial graph families). `limits.results`
 * caps the relations (after authorization), `limits.expand` is graphNeighbors'.
 * A seed the caller cannot see gets the empty answer with no store op.
 */
export async function retrieveCandidates(store, { seed, intent, canSeeKey, isIndexable, budget, limits, scope }) {
  const visible = (key) => {
    try {
      return canSeeKey(key) === true;
    } catch {
      return false;
    }
  };
  const nothing = { relations: [], unresolved: [], possiblyIncomplete: true };
  if (typeof seed?.path !== "string" || !visible(seed.path)) return nothing;
  const limit = Number.isInteger(limits?.results) && limits.results > 0 ? limits.results : RESULT_LIMIT;
  let incomplete = false;

  // Catalog: the visible paths of the index's docmap, `paths` only on a
  // converged index (neighbors.js: an unlisted note is unknown, not missing).
  let catalog = { byName: new Map() };
  try {
    const docmap = await loadDocmapPaths(store, budget, 0);
    if (!docmap) incomplete = true;
    else {
      const seen = docmap.paths.filter(visible);
      catalog = { byName: indexByName(seen), ...(!indexIsBehind(docmap.freshness) && { paths: new Set(seen) }) };
    }
  } catch {
    incomplete = true;
  }

  // Lexical: one loose query. An encrypted seed has no words to ask with (OPEN-32).
  let hits = [];
  const query = isEncryptedNote(seed.body ?? "") ? "" : seedQuery(seed, intent);
  if (query) {
    try {
      const found = await searchIndexedNotes(store, { isVisible: visible, isIndexable, query, budget, limit: limit + 1 });
      if (!found.indexed) incomplete = true;
      else {
        hits = found.hits;
        if (found.indexIncomplete) incomplete = true;
      }
    } catch {
      incomplete = true;
    }
  }

  let graph = { incoming: new Map(), outgoing: new Map(), sharedTargets: new Map(), sharedUrls: new Map(), unresolved: [] };
  try {
    graph = await graphNeighbors(store, budget, { path: seed.path, body: seed.body ?? "", catalog, canSeeKey: visible, scope, limits });
    if (!graph.complete || graph.health.possiblyIncomplete) incomplete = true;
  } catch {
    incomplete = true;
  }

  // Merge by note path, every reason kept.
  const found = new Map();
  const note = (path, reason) => {
    if (path === seed.path || !visible(path)) return null;
    let r = found.get(path);
    if (!r) found.set(path, (r = { path, reasons: new Set(), score: 0 }));
    r.reasons.add(reason);
    return r;
  };
  // Independently ranked lists, fused by rank (OPEN-31). Explicit links: the
  // seed's own targets in document order, then backlinks in path order.
  const explicit = [...graph.outgoing.keys(), ...[...graph.incoming.keys()].filter((p) => !graph.outgoing.has(p))];
  for (const p of graph.outgoing.keys()) note(p, "linked_from_here");
  for (const p of graph.incoming.keys()) note(p, "links_here");
  for (const p of graph.sharedTargets.keys()) note(p, "shares_target");
  for (const p of graph.sharedUrls.keys()) note(p, "shares_url");
  const text = [];
  for (const hit of hits) {
    const path = notePathOf(hit.key);
    const r = note(path, "related_text");
    if (!r) continue;
    if (!text.includes(path)) text.push(path);
    if (r.evidence === undefined && hit.snippets?.[0]) r.evidence = hit.snippets[0];
  }
  for (const list of [explicit, byScoreThenPath(graph.sharedTargets), byScoreThenPath(graph.sharedUrls), text]) {
    list.forEach((p, i) => {
      const r = found.get(p);
      if (r) r.score += 1 / (RRF_K + i + 1);
    });
  }
  for (const r of found.values()) if (directoryDistance(seed.path, r.path) <= NEARBY_DISTANCE) r.reasons.add("nearby");

  // Explicit links first, so a text hit never cuts one; then fused score,
  // `nearby` as the tie-break, then path.
  const tier = (r) => ([...r.reasons].some((x) => EXPLICIT.has(x)) ? 0 : 1);
  const ranked = [...found.values()].sort((a, b) =>
    tier(a) - tier(b) || b.score - a.score || Number(b.reasons.has("nearby")) - Number(a.reasons.has("nearby")) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const relations = ranked.slice(0, limit).map((r) => ({
    path: r.path,
    reasons: REASONS.filter((x) => r.reasons.has(x)),
    ...(r.evidence !== undefined && { evidence: r.evidence }),
  }));
  return { relations, unresolved: graph.unresolved, possiblyIncomplete: incomplete };
}
