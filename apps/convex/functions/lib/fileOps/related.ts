/**
 * Notes related to one note, for the console's note view (Task 18).
 *
 * The gateway's `retrieveCandidates`, imported rather than ported, as
 * `search.ts` imports the gateway's search: two copies of "what is related and
 * who may see it" would let the console and an AI client's `related_notes`
 * disagree about the same note.
 *
 * Privacy. The seed is read through `readFile`, so a note outside the caller's
 * clearance throws exactly the read operation's not-found, before any graph or
 * index read. Every candidate then passes this runtime's own `canSee`, as
 * `notePathIndex` filters the docmap. `scope` is the caller's tier: only an
 * owner (`private`) gets partial graph families; everyone else is strict
 * (docs/decisions/link-graph.md, OPEN-27 and OPEN-33).
 *
 * This store has no `forkLogicalView`, so `graphView` hands the graph the
 * store itself, billed through the same budget.
 */

import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { retrieveCandidates } from "../../../../mcp/src/graph/retrieve.js";
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
import type { FileStore } from "./store";
import { loadPrivacyState } from "./privacyState";
import { readFile } from "./reading";
import { CONSOLE_SEARCH_BUDGET } from "./search";

export type RelationReason =
  | "links_here"
  | "linked_from_here"
  | "shares_target"
  | "shares_url"
  | "related_text"
  | "nearby";

export type UnresolvedState = "missing" | "ambiguous" | "unsupported" | "invalid" | "unknown";

export interface RelatedNotes {
  /** Untrusted note text in `evidence`: render it as plain text, never markup. */
  relations: { path: string; reasons: RelationReason[]; evidence?: string }[];
  /** The seed's own links that do not resolve to a note the caller can see. */
  unresolved: { target: string; start: number; end: number; state: UnresolvedState }[];
  possiblyIncomplete: boolean;
}

export async function relatedNotes(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<RelatedNotes> {
  const { clearance } = options;
  const seed = await readFile(store, { path: options.path, clearance });
  const state = await loadPrivacyState(store);
  const isVisible = (path: string) =>
    !isPlumbing(path) && canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  return (await retrieveCandidates(store as unknown as Parameters<typeof retrieveCandidates>[0], {
    seed: { path: seed.path, body: seed.text },
    intent: "related_notes",
    canSeeKey: isVisible,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    budget: createSearchBudget(CONSOLE_SEARCH_BUDGET),
    limits: undefined,
    scope: clearance.scope,
  })) as RelatedNotes;
}
