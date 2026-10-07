// Graph neighbourhood of one note for one caller (arch 12.1, 12.4). The
// retrieval core (OPEN-26): `retrieve.js`, the Convex operation and
// suggestions import this without the tool layer.
//
// Outgoing links and unresolved references come from the body in the request,
// resolved against the caller's catalog, so they are never stale. Backlinks,
// shared targets and shared URLs come from the postings of one pinned
// generation, through `graphView`, with `canSeeKey` applied to every entry
// before it is counted or validated: a hidden note changes no path, score or
// count in the answer. The one residual (OPEN-27, arch 12.4): how many ops a
// chain costs depends on hidden entries in its pages, so for a non-owner a
// family whose chain did not finish is withheld whole and the answer is
// labelled incomplete rather than listed in part. Never throws.
import { isEncryptedNote } from "../encryption.js";
import { extractReferences, resolveReference } from "../links.js";
import { nameHash, pathHash, urlHash } from "./keys.js";
import { graphHealth, unavailableHealth } from "./manifest.js";
import { graphView } from "./mode.js";
import { readPostings } from "./postings.js";
import { validateEntry } from "./project.js";
import { urlKey } from "./urlKey.js";

// Experiment parameters (OPEN-28, arch 12.3), to be tuned in Phase 5. A target
// or URL with more visible citers than HUB_DEGREE_CAP is not expanded; below
// it each citer earns 1 / log2(2 + d), d the visible citers (the seed
// included), counted before validation so a hub costs no node reads.
export const HUB_DEGREE_CAP = 50;
const hubWeight = (d) => 1 / Math.log2(2 + d);
// Distinct targets and distinct URLs expanded per seed, in document order,
// unless `limits.expand` says otherwise. The cut depends on the seed's own
// text only, so it is not reported as incomplete.
export const MAX_EXPANDED = 20;

// Graph maps are returned in path order: chain order depends on where hidden
// entries sat, so it must never reach the caller (fix round 1).
const byPath = (map) => new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/**
 * `{ incoming, outgoing, sharedTargets, sharedUrls, unresolved, complete, health }`
 * for `path` (Task 15 data model). `health` is the `graphHealth` answer this
 * call read; `complete` says every chain finished. `catalog` holds only what
 * the caller may see (`byName`, and `paths` only when the index is
 * converged). `scope` is the caller's scope; anything but exactly "private"
 * gets the OPEN-27 rule: when any chain did not finish, every graph map is
 * empty. A seed the caller cannot see gets the empty answer with no store op.
 * An encrypted body yields incoming only (OPEN-32, arch 7.6).
 */
export async function graphNeighbors(store, budget, { path, body, catalog, canSeeKey, scope, limits }) {
  if (!(await canSeeKey(path))) {
    return { incoming: new Map(), outgoing: new Map(), sharedTargets: new Map(), sharedUrls: new Map(), unresolved: [], complete: false, health: unavailableHealth(store) };
  }
  const outgoing = new Map();
  const unresolved = [];
  const targets = [];
  const urls = [];
  if (!isEncryptedNote(body)) {
    for (const occ of extractReferences(body)) {
      const r = resolveReference(occ, path, catalog);
      if (r.state === "resolved") {
        if (r.path === path) continue;
        const seen = outgoing.get(r.path);
        if (seen) seen.occurrences += 1;
        else {
          outgoing.set(r.path, { occurrences: 1 });
          if (r.path.endsWith(".md")) targets.push(r.path); // OPEN-5: only .md targets have incoming/
        }
      } else if (r.state === "external") {
        // Definitions are unsupported (arch 7.1): facts.js posts no URL for them.
        const k = occ.kind === "definition" ? null : urlKey(occ.target);
        if (k && !urls.includes(k.key)) urls.push(k.key);
      } else {
        unresolved.push({ target: occ.target, start: occ.start, end: occ.end, state: r.state });
      }
    }
  }
  const view = graphView(store, budget);
  let health;
  try {
    health = await graphHealth(view, budget);
  } catch {
    health = unavailableHealth(store); // an unreadable manifest is an unavailable graph
  }
  const empty = { incoming: new Map(), outgoing, sharedTargets: new Map(), sharedUrls: new Map(), unresolved, complete: false, health };
  const gen = health.state === "unavailable" ? null : health.generation;
  if (!gen) return empty;

  const validate = validateEntry(view, budget, gen);
  // A throw (the view's charge refusing a wrapper read, a store fault) is an
  // unfinished chain, never an error for the caller.
  const read = async (family, hash, check) => {
    try {
      return await readPostings(view, budget, { gen, family, hash, canSee: canSeeKey, validate: check });
    } catch {
      return { entries: [], complete: false };
    }
  };

  const incoming = new Map();
  let incomingOk = true;
  const exact = await read("incoming", await pathHash(path), validate);
  incomingOk &&= exact.complete;
  for (const e of exact.entries) if (e.source !== path) incoming.set(e.source, { exact: true, bare: false });
  // Late binding (arch 7.4): a bare citer counts only when the name resolves
  // to this note alone in the caller's own catalog.
  const name = baseName(path);
  const named = catalog.byName?.get(name);
  if (named?.length === 1 && named[0] === path) {
    const bare = await read("bare", await nameHash(name), validate);
    incomingOk &&= bare.complete;
    for (const e of bare.entries) if (e.source !== path) incoming.set(e.source, { exact: incoming.has(e.source), bare: true });
  }

  const expand = Number.isInteger(limits?.expand) && limits.expand >= 0 ? limits.expand : MAX_EXPANDED;
  // Once the budget is gone nothing more can finish; stop rather than walk on.
  const gone = () => budget.remaining === 0;
  const shared = async (keys, family, hashOf) => {
    const scores = new Map();
    let ok = true;
    for (const key of keys.slice(0, expand)) {
      if (gone()) return { scores, ok: false };
      const visible = await read(family, await hashOf(key), () => true);
      ok &&= visible.complete;
      const d = visible.entries.length;
      if (d > HUB_DEGREE_CAP) continue;
      for (const e of visible.entries) {
        if (e.source === path) continue;
        let valid = false;
        try {
          valid = await validate(e);
        } catch {
          if (gone()) return { scores, ok: false };
          ok = false;
        }
        if (valid) scores.set(e.source, (scores.get(e.source) ?? 0) + hubWeight(d));
      }
    }
    return { scores, ok };
  };
  const byTarget = await shared(targets, "incoming", pathHash);
  const byUrl = await shared(urls, "urls", urlHash);

  const complete = incomingOk && byTarget.ok && byUrl.ok;
  // OPEN-27, fix round 1: all graph families or none, so a strict caller learns
  // one bit (withheld or not) and never which chain ran long.
  if (!complete && scope !== "private") return empty;
  return {
    incoming: byPath(incoming),
    outgoing,
    sharedTargets: byPath(byTarget.scores),
    sharedUrls: byPath(byUrl.scores),
    unresolved,
    complete,
    health,
  };
}
