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
import { ANCHOR_REFRESH_OPS, refreshAnchorTargets } from "../search/anchors.js";
import { defaultIsIndexable } from "../search/maintain.js";

// AGENT-LINKS 13.5: suggestion work, structural analysis included, ends this
// long after it starts.
export const SUGGEST_DEADLINE_MS = 250;
/**
 * Project one written note. With budget 0 the manifest read is refused before any store op; with no manifest (reconciliation
 * creates it, Task 10), nothing else runs. A "pending" or "stale" result is
 * left to reconciliation. Then, the link
 * targets whose postings changed are re-indexed on a budget of their own
 * (`refreshBudget`, ANCHOR_REFRESH_OPS by default); `visibilityOf` is the
 * privacy engine as of this write. Never rejects.
 */
export async function projectNoteAfterWrite(shared, { path, body, version, budget, visibilityOf, refreshBudget = ANCHOR_REFRESH_OPS }) {
  try {
    // A logical-delete store's extra physical calls (a raw read before a
    // conditional write, marker probes) count against this budget, on a view
    // of its own so nothing else the write deferred is billed (graphView).
    const store = graphView(shared, budget);
    const manifest = await loadGraphManifest(store, budget);
    // Newer code's generation: an older client never writes into it (arch 9.6).
    if (!manifest || isNewer(manifest)) return;
    const { touched } = await projectNote(store, path, body, version, {
      budget,
      gen: manifest.generation,
      mode: graphMode(store),
      now: Date.now(),
    });
    await refreshAnchorTargets(shared, touched, { visibilityOf, budget: refreshBudget, isIndexable: defaultIsIndexable });
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
 * `budget` is what suggestions may spend (the invocation's pool, or this
 * write's own). Never throws: any exception is `unavailable`.
 */
export async function suggestAfterWrite(store, scope, rules, overrides, write, budget, now = Date.now) {
  try {
    const deadline = now() + SUGGEST_DEADLINE_MS;
    if (write.before === undefined) return { status: "skipped", basedOnEtag: write.etag, candidates: [] };
    // Owner decision (2026-10-07): the owner's share links, one control-plane
    // call per write, for "shared publicly" labels. Started now so it overlaps
    // the retrieval inside the deadline and runs past it only when slower than
    // the whole pass. Scope `private` is the owner's alone; a teammate makes
    // no call. Absent or failing, there are no public labels.
    const publicLinks = scope === "private" && typeof store.links?.list === "function" ? Promise.resolve().then(() => store.links.list()).catch(() => null) : null;
    const { sections } = detectChangedSections(write.before, write.committed);
    // The audience is the note's after this write, which may just have set its
    // override (persistExactVisibility writes storage, not this map). Set as
    // persistExactVisibility sets it, so the fold reads it the same way.
    // Share links label the block; they do not narrow the audience (owner decision, 2026-10-07).
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
        publicLinks,
      },
      budget,
      { deadline, now },
    );
  } catch {
    return { status: "unavailable", basedOnEtag: write.etag, candidates: [] };
  }
}
