/**
 * `related_notes`: the notes related to one note, with the reasons for each
 * (arch 12, Task 17). Candidates come from `retrieveCandidates`, which runs
 * every part over what this caller may see; this file resolves the seed and
 * renders the answer.
 *
 * Privacy. The seed resolves exactly as `read_note` resolves a path (the
 * order `toolOpenAiFetch` repeats: metadata first, forwarding on any refusal,
 * the decision at the end), so a note held back and a note never written
 * answer the same words at the same cost. The answer prints paths and
 * reasons only: no counts, no health, no unresolved links (OPEN-35).
 */

import { canSee } from "../privacy/engine.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { graphView } from "../graph/mode.js";
import { retrieveCandidates } from "../graph/retrieve.js";
import { getVisibleMovedNote } from "../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { createSearchBudget, defaultIsIndexable } from "../search/maintain.js";
import { SEARCH_RESULT_LIMIT, SEARCH_SUBREQUEST_BUDGET } from "../search/visible.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { toolError, toolText } from "./results.js";

const MAX_LIMIT = 25;

export async function toolRelatedNotes(store, scope, rules, overrides, args) {
  const requested = splitMessageAnchor(normalizePath(args.path) ?? "").path;
  if (!requested) return toolError("invalid path");
  const seen = canSee(requested, scope, rules, overrides);
  let path = requested;
  const found = await getVisibleMovedNote(store, scope, rules, overrides, requested, probeWithLegacyFallback);
  let present = Boolean(found.object);
  let obj = seen && present ? await getWithLegacyFallback(store, found.physicalPath) : null;
  if (seen && present && !obj) present = false;
  if (!seen || !present) {
    const forwarded = forwardPath(await readForwarding(store), requested);
    if (forwarded !== requested && canSee(forwarded, scope, rules, overrides)) {
      const landed = await getVisibleMovedNote(store, scope, rules, overrides, forwarded, probeWithLegacyFallback);
      if (landed.object && seen && !present) {
        const landedObject = await getWithLegacyFallback(store, landed.physicalPath);
        if (landedObject) {
          present = true;
          path = forwarded;
          obj = landedObject;
        }
      }
    }
  }
  if (!seen || !present || !obj) return toolError("not found");
  // The stored bytes, not decrypted: an encrypted seed gets backlinks only and
  // no text query (OPEN-32), which retrieve.js decides from the envelope.
  const body = await obj.text();

  // lean: limit clamped rather than refused by the schema, per the OPEN-34 ruling.
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? args.limit : SEARCH_RESULT_LIMIT));
  const budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET);
  const { relations, possiblyIncomplete } = await retrieveCandidates(graphView(store, budget), {
    seed: { path, body },
    intent: "related_notes",
    canSeeKey: (key) => canSee(key, scope, rules, overrides),
    isIndexable: defaultIsIndexable,
    budget,
    limits: { results: limit },
    scope,
  });
  const lines = [];
  for (const { path: related, reasons, evidence } of relations) {
    lines.push(`${related} (${reasons.join(", ")})`);
    // Note text, untrusted: one JSON string literal, never markup or
    // instructions. JSON leaves U+2028, U+2029 and U+0085 raw, and a client
    // may break lines on them, so they are escaped too.
    if (evidence !== undefined) {
      const quoted = JSON.stringify(evidence).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
      lines.push(`  evidence: ${quoted}`);
    }
  }
  if (!lines.length) lines.push("(no related notes found)");
  if (possiblyIncomplete) lines.push("may be incomplete");
  return toolText(lines.join("\n"));
}
