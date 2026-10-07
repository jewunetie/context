// The post-commit graph hook (arch 16.3): the committed path, body and version
// of a Context-managed write are change hints for the link graph. The graph is
// a derivative, so nothing here may reject, slow or change the write: every
// exception is swallowed (reconciliation repairs what is missed) and, where the
// host can, the work runs behind the response.
import { canSee, PrivacyOverrides, visibilityOf } from "../privacy/engine.js";
import { detectChangedSections } from "./changes.js";
import { loadGraphManifest } from "./manifest.js";
import { graphMode, graphView } from "./mode.js";
import { projectNote } from "./project.js";
import { isNewer } from "./rebuild.js";
import { suggestLinks } from "./suggest.js";
import { afterResponse } from "../search/writeProjection.js";
import { defaultIsIndexable } from "../search/maintain.js";
import { WRITE_ENRICH_SUBREQUEST_BUDGET } from "../search/budget.js";

// AGENT-LINKS 13.5: suggestion work, structural analysis included, ends this
// long after it starts.
export const SUGGEST_DEADLINE_MS = 250;
// What suggestions may spend of a write's enrichment budget: two changed
// sections at the 20 ops one measured on a one-shard index (catalog, search,
// snippets, graph). The graph hook keeps the Task 8 default before
// suggestions take anything, so at budget 8 they skip with no op and at the
// hosted 80 the graph keeps at least 40.
export const SUGGEST_SUBREQUEST_CAP = 40;
const GRAPH_FLOOR = WRITE_ENRICH_SUBREQUEST_BUDGET;

/**
 * Project one written note. With budget 0 the manifest read is refused before any store op; with no manifest (reconciliation
 * creates it, Task 10), nothing else runs. A "pending" or "stale" result is
 * left to reconciliation. Never rejects.
 */
export async function projectNoteAfterWrite(shared, { path, body, version, budget }) {
  try {
    // A logical-delete store's extra physical calls (a raw read before a
    // conditional write, marker probes) count against this budget, on a view
    // of its own so nothing else the write deferred is billed (graphView).
    const store = graphView(shared, budget);
    const manifest = await loadGraphManifest(store, budget);
    // Newer code's generation: an older client never writes into it (arch 9.6).
    if (!manifest || isNewer(manifest)) return;
    await projectNote(store, path, body, version, {
      budget,
      gen: manifest.generation,
      mode: graphMode(store),
      now: Date.now(),
    });
  } catch {
    // A derivative's failure is one note late, not a failed write.
  }
}

/** `projectNoteAfterWrite` behind the response where `store.defer` exists. Never rejects. */
export async function projectNoteAfterWriteDeferred(store, hint) {
  try {
    await afterResponse(store, () => projectNoteAfterWrite(store, hint));
  } catch {
    // Same contract as above.
  }
}

/**
 * The `linkSuggestions` block for one committed `write_note` (AGENT-LINKS
 * 13.6, Task 23). `write` is `{ path, etag, visibility, before, committed }`:
 * `visibility` the note's visibility after the write, `before` the plaintext
 * the diff starts from (`undefined` when there is none to use, for an
 * encrypted note or a drawing), `committed` the committed plaintext. `rules`
 * and `overrides` are the privacy state the write was authorized under.
 * Spends at most SUGGEST_SUBREQUEST_CAP of `budget` and never its last
 * GRAPH_FLOOR. Never throws: any exception is `unavailable`.
 */
export async function suggestAfterWrite(store, scope, rules, overrides, write, budget, now = Date.now) {
  try {
    const deadline = now() + SUGGEST_DEADLINE_MS;
    if (write.before === undefined) return { status: "skipped", basedOnEtag: write.etag, candidates: [] };
    const { sections } = detectChangedSections(write.before, write.committed);
    // The audience is the note's after this write, which may just have set its
    // override (persistExactVisibility writes storage, not this map). Set as
    // persistExactVisibility sets it, so the fold reads it the same way.
    // lean: share links are not part of the audience (owner decision pending, Task 22); a team note with a link gets team candidates.
    const after = new PrivacyOverrides(overrides ?? []);
    if (write.visibility === visibilityOf(write.path, rules)) after.delete(write.path);
    else after.set(write.path, write.visibility);
    return await suggestLinks(
      store,
      scope,
      {
        path: write.path,
        committed: write.committed,
        etag: write.etag,
        sections,
        audience: { rules, overrides: after },
        canSeeKey: (key) => canSee(key, scope, rules, after),
        isIndexable: defaultIsIndexable,
      },
      share(budget),
      { deadline, now },
    );
  } catch {
    return { status: "unavailable", basedOnEtag: write.etag, candidates: [] };
  }
}

/** `budget` as seen by suggestions: at most SUGGEST_SUBREQUEST_CAP ops, never its last GRAPH_FLOOR. */
function share(budget) {
  let spent = 0;
  const view = {
    get remaining() {
      return Math.max(0, Math.min(SUGGEST_SUBREQUEST_CAP - spent, budget.remaining - GRAPH_FLOOR));
    },
    get spent() {
      return spent;
    },
    take(reserve = 0) {
      if (view.remaining <= reserve || !budget.take(GRAPH_FLOOR)) return false;
      spent += 1;
      return true;
    },
  };
  return view;
}
