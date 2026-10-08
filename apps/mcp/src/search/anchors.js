/**
 * Anchor text: the words other notes use for a note, added to its search
 * document (CONTRACT-v3.md "Anchor text"). Only for a v3 index whose format
 * carries `anchors: true` (`SEARCH_ANCHOR_TEXT=1`, `format.js`).
 *
 * The link graph records, on each `incoming:` and `bare:` posting entry, the
 * link's display texts and the source note's title (`graph/facts.js`). When
 * the sync indexes note B it reads page 0 of B's two postings and adds what
 * they carry as a fifth field, weighted below the body (`shardQuery.js`).
 * Nothing is read at query time.
 *
 * Privacy, two layers:
 * - Admission, here: a source's text is added only when the source's
 *   visibility is at least as wide as B's (`admitsAnchor`), using the privacy
 *   engine's own `narrowerVisibility`. A private source never adds to a team
 *   note; a group source never adds to a team note or another group's.
 * - The guard, in `shardQuery.js`: B's document keeps the list of sources, and
 *   a caller who cannot see every one of them gets B scored without the field.
 *   That holds after a visibility change no re-index has caught up with.
 *
 * Freshness: the graph reports which targets' postings an edit, a delete or a
 * reconciliation pass changed (`touched`); those notes are re-indexed by a
 * targeted pass (`refreshAnchorTargets`), and what a pass could not afford is
 * kept on the v3 manifest (`anchorRefresh`, at most ANCHOR_REFRESH_CAP paths)
 * for the next pass of any kind.
 */

import { narrowerVisibility } from "../privacy/engine.js";
import { baseName } from "../graph/facts.js";
import { isNewer, readGraphManifest } from "../graph/manifest.js";
import { nameHash, pathHash } from "../graph/keys.js";
import { readPostings } from "../graph/postings.js";
import { createSearchBudget } from "./maintain.js";
import { writerFor } from "./shards/revisions.js";
import { syncPass } from "./shards/sync.js";

export { ANCHOR_TEXT_CHARS, ANCHOR_TEXTS_PER_ENTRY, ANCHOR_TITLE_CHARS } from "../graph/facts.js";
export { ANCHOR_FIELD_B, ANCHOR_FIELD_WEIGHT } from "./shardQuery.js";
export { ANCHORS_UNREAD, unmarked } from "./shards/constants.js";

/** Sources whose text one note's document takes, in posting order. */
export const ANCHOR_SOURCES_PER_TARGET = 32;
/** Posting pages read per family per note: page 0 only (256 entries). */
export const ANCHOR_POSTING_PAGES = 1;
/** Paths kept on the v3 manifest for a later refresh; the oldest go first past it. */
export const ANCHOR_REFRESH_CAP = 256;
/** Passes a refresh tries when it loses the manifest race to another writer. */
const REFRESH_ATTEMPTS = 3;
/** Store ops a refresh behind a write may spend (the write path's own WRITE_INDEX_OPS). */
export const ANCHOR_REFRESH_OPS = 24;

/** Whether text from a source at `source` visibility may join a note at `target` visibility. */
export function admitsAnchor(source, target) {
  if (typeof source !== "string" || typeof target !== "string") return false;
  return narrowerVisibility(source, target) === target;
}

/**
 * The anchor field for `path` from its posting `entries`, or null when none is
 * admitted. Skips the note itself, sources `known` does not name (deleted or
 * not indexed) and every source `admitsAnchor` refuses; keeps the first
 * ANCHOR_SOURCES_PER_TARGET sources. No `visibilityOf`: nothing is admitted.
 */
export function collectAnchors(entries, { path, known, visibilityOf }) {
  if (typeof visibilityOf !== "function") return null;
  const target = visibilityOf(path);
  const sources = [];
  const parts = [];
  for (const entry of entries) {
    if (sources.length >= ANCHOR_SOURCES_PER_TARGET) break;
    const { source } = entry;
    if (source === path || sources.includes(source) || !known(source)) continue;
    if (!admitsAnchor(visibilityOf(source), target)) continue;
    sources.push(source);
    for (const text of Array.isArray(entry.texts) ? entry.texts : []) if (typeof text === "string" && text) parts.push(text);
    if (typeof entry.title === "string" && entry.title) parts.push(entry.title);
  }
  return sources.length ? { text: parts.join("\n"), sources } : null;
}

/** A budget view over `take`, for the graph readers (`take()` true when the op is paid). */
const takeOnly = (take) => ({
  get remaining() {
    return 1;
  },
  take: () => take(),
});

/**
 * Per-pass reader for `syncPass`. `paths` is every note the pass knows
 * (listing plus docmap), for existence and bare-name uniqueness. The caller
 * pays first: `load(take)` reads the graph manifest (one op, once per pass);
 * `anchorsFor(path, take)` reads page 0 of the note's `incoming:` and, when its
 * name is unique, `bare:` posting (at most ANCHOR_READS ops, prepaid by the
 * caller so a note is fetched only when its anchors can be read too). It
 * resolves to the field, null for none (also with no graph, or a newer one),
 * or `undefined` when it could not be read (manifest not loaded, no
 * `visibilityOf`, a refused op, a store fault): the caller then keeps the
 * note's previous field and marks it ANCHORS_UNREAD.
 */
export function anchorReader(store, { visibilityOf, paths }) {
  let generation;
  let names;
  const known = (path) => paths.has(path);
  return {
    /** Whether `anchorsFor` can read anything this pass (false before `load`). */
    get usable() {
      return typeof visibilityOf === "function" && typeof generation === "string";
    },
    get loaded() {
      return generation !== undefined;
    },
    async load(take) {
      if (generation !== undefined) return;
      try {
        const { manifest } = await readGraphManifest(store, takeOnly(take));
        generation = manifest && !isNewer(manifest) ? manifest.generation : null;
      } catch {
        generation = null;
      }
    },
    async anchorsFor(path, take) {
      if (typeof visibilityOf !== "function" || generation === undefined) return undefined;
      if (generation === null) return null; // no graph, or a newer one: no anchor text
      if (!names) {
        names = new Map();
        for (const p of paths) names.set(baseName(p), (names.get(baseName(p)) ?? 0) + 1);
      }
      const read = async (family, hash) => {
        let refused = false;
        const got = await readPostings(store, takeOnly(() => take() || ((refused = true), false)), {
          gen: generation, family, hash, canSee: () => true, validate: () => true, pages: ANCHOR_POSTING_PAGES,
        });
        return refused ? null : got.entries;
      };
      try {
        const exact = await read("incoming", await pathHash(path));
        if (exact === null) return undefined;
        // A bare link counts only when its name is this note's alone (arch 7.4).
        const bare = names.get(baseName(path)) === 1 ? await read("bare", await nameHash(baseName(path))) : [];
        if (bare === null) return undefined;
        return collectAnchors([...exact, ...bare], { path, known, visibilityOf });
      } catch {
        return undefined; // a store fault: keep what the note had
      }
    },
  };
}

/** Posting reads one note's anchors may take: `incoming:` and `bare:` page 0. */
export const ANCHOR_READS = 2 * ANCHOR_POSTING_PAGES;

/**
 * The v3 paths a pass should re-index for anchors: the manifest's carried
 * list, then `refresh` (`{ path }` or `{ name }` from the graph), resolved
 * against `paths` (a name only when exactly one note has it) and kept only
 * when indexed (`claimed`).
 */
export function refreshPaths(carried, refresh, paths, claimed) {
  const out = [];
  const add = (path) => {
    if (typeof path === "string" && claimed.has(path) && !out.includes(path)) out.push(path);
  };
  for (const path of Array.isArray(carried) ? carried : []) add(path);
  let byName = null;
  for (const target of Array.isArray(refresh) ? refresh : []) {
    if (typeof target?.path === "string") add(target.path);
    else if (typeof target?.name === "string") {
      if (!byName) {
        byName = new Map();
        for (const p of paths) byName.set(baseName(p), byName.has(baseName(p)) ? null : p);
      }
      const unique = byName.get(target.name);
      if (unique) add(unique);
    }
  }
  return out;
}

/**
 * Re-index the notes in `touched` for their anchor field, in the v3 index,
 * behind a write or after a reconciliation pass. A pass with no listing: the
 * notes are fetched by name; what it cannot afford stays on the manifest.
 * Does nothing unless the configured format has anchors. Never rejects.
 */
export async function refreshAnchorTargets(store, touched, { visibilityOf, budget = ANCHOR_REFRESH_OPS, isIndexable } = {}) {
  const writer = writerFor(store);
  if (!writer.format?.anchors || !Array.isArray(touched) || touched.length === 0) return;
  try {
    const ops = typeof budget === "object" && budget ? budget : createSearchBudget(budget);
    // A write's own targeted pass runs beside this one; the manifest is the
    // concurrency point, so a pass that lost it re-reads and tries again.
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
      const pass = await syncPass(store, { budget: ops, only: new Map(), refresh: touched, visibilityOf, ...(isIndexable && { isIndexable }) }, writer);
      if (pass.committed || !pass.changed) return;
    }
  } catch {
    // A derivative one refresh late; the manifest's list or the note's own next edit catches up.
  }
}
