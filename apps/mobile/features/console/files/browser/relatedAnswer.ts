/**
 * The console's reader for `functions/files.relatedNotes` (link-graph Task 19).
 *
 * Imports nothing, so `apps/convex/__tests__/relatedNotes.test.ts` can feed the
 * action's real serialized answer through this same function (DELIVERY 18.1,
 * cross-surface contract).
 *
 * It throws on anything that is not exactly the action's shape. A field the
 * panel prints has to be one the action sent: a partly understood answer drawn
 * as if whole is how a reason, a state or a "complete" claim gets invented.
 */

export type RelationReason =
  | "links_here"
  | "linked_from_here"
  | "shares_target"
  | "shares_url"
  | "related_text"
  | "nearby";

/** All five, `invalid` included: a malformed link in the note produces it. */
export type UnresolvedState = "missing" | "ambiguous" | "unsupported" | "invalid" | "unknown";

export interface RelatedAnswer {
  /** `evidence` is untrusted note text: render it as plain text, never markup. */
  relations: { path: string; reasons: RelationReason[]; evidence?: string }[];
  /** The open note's own links that do not open a note this person can see. */
  unresolved: { target: string; start: number; end: number; state: UnresolvedState }[];
  possiblyIncomplete: boolean;
}

/** What each reason is called on screen. */
export const REASON_WORDS: Record<RelationReason, string> = {
  links_here: "links here",
  linked_from_here: "linked from here",
  shares_target: "cites the same note",
  shares_url: "cites the same URL",
  related_text: "related text",
  nearby: "nearby",
};

/** What each unresolved state is called on screen. */
export const STATE_WORDS: Record<UnresolvedState, string> = {
  missing: "missing",
  ambiguous: "ambiguous",
  unsupported: "not supported",
  invalid: "not a valid link",
  unknown: "not yet checked",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(what: string): never {
  throw new Error(`Malformed related-notes answer: ${what}`);
}

export function parseRelatedAnswer(raw: unknown): RelatedAnswer {
  if (!isObject(raw) || raw.kind !== "related") fail("not a related answer");
  if (typeof raw.possiblyIncomplete !== "boolean") fail("possiblyIncomplete");
  if (!Array.isArray(raw.relations)) fail("relations");
  if (!Array.isArray(raw.unresolved)) fail("unresolved");

  const relations = raw.relations.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.path !== "string" ||
      item.path === "" ||
      !Array.isArray(item.reasons) ||
      item.reasons.length === 0
    ) {
      fail("relation");
    }
    const reasons = item.reasons.map((reason: unknown) => {
      if (typeof reason !== "string" || !Object.hasOwn(REASON_WORDS, reason)) fail("reason");
      return reason as RelationReason;
    });
    if (item.evidence !== undefined && typeof item.evidence !== "string") fail("evidence");
    return item.evidence === undefined
      ? { path: item.path, reasons }
      : { path: item.path, reasons, evidence: item.evidence };
  });

  const unresolved = raw.unresolved.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.target !== "string" ||
      !Number.isFinite(item.start) ||
      !Number.isFinite(item.end) ||
      typeof item.state !== "string" ||
      !Object.hasOwn(STATE_WORDS, item.state)
    ) {
      fail("unresolved link");
    }
    return { target: item.target, start: item.start as number, end: item.end as number, state: item.state as UnresolvedState };
  });

  // One row per note: a repeated path is dropped, the first kept.
  const seen = new Set<string>();
  const unique = relations.filter((relation) => !seen.has(relation.path) && Boolean(seen.add(relation.path)));
  return { relations: unique, unresolved, possiblyIncomplete: raw.possiblyIncomplete };
}
