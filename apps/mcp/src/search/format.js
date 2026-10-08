/**
 * The search index format: which tokenizer and which chunking an index was
 * built with. See CONTRACT-v3.md.
 *
 * `DEFAULT_FORMAT` is today's index, stored under `.context/search/v2/`. Any
 * other format lives under `.context/search/v3/` and is read only when it is
 * configured, usable and fully built (`shards/io.js`, `loadIndexManifest`), so
 * with nothing configured no reader or writer behaves differently.
 *
 * The switch is two deployment vars (ruling OPEN-57), unset in production:
 * `SEARCH_TOKENIZER` ("1" or "2") and `SEARCH_CHUNK_CHARS` ("0" or absent for
 * no chunking, "1000", "2000", "4000"). Anything else is the default for that
 * field, never a throw: a bad var must not take down search (the
 * `searchBudgetFor` rule, `budget.js`).
 *
 * A third var, `SEARCH_ANCHOR_TEXT` (exactly "1"), adds `anchors: true`: each
 * document gets the display text and source titles of the links pointing at
 * it as a fifth, low-weight field (`anchors.js`, CONTRACT-v3.md "Anchor
 * text"). It is part of the format, so flipping it builds a new v3 index and
 * the field is never half present; absent, the format object has no
 * `anchors` key at all, so every stored byte is what it was before.
 */

import { segmenterSelfTest } from "./text.js";

export const DEFAULT_FORMAT = Object.freeze({ tokenizer: 1, chunk: null });

const TOKENIZERS = [1, 2];
const CHUNK_TARGETS = [1000, 2000, 4000];
/** Characters of one note that are indexed at all when chunking (P8). */
const CHUNK_NOTE_CAP = 64_000;

/** `max = 1.5 * target` (ruling OPEN-54): 1,500, 3,000 and 6,000. */
function chunkFor(target) {
  return { target, max: target * 1.5, cap: CHUNK_NOTE_CAP };
}

function varText(raw) {
  return typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
}

/**
 * The configured format, from an env-shaped object.
 *
 * @param {{ SEARCH_TOKENIZER?: string, SEARCH_CHUNK_CHARS?: string } | undefined} source
 * @returns {{ tokenizer: 1 | 2, chunk: null | { target: number, max: number, cap: number } }}
 */
export function indexFormatFor(source) {
  const tokenizer = varText(source?.SEARCH_TOKENIZER) === "2" ? 2 : 1;
  const target = Number(varText(source?.SEARCH_CHUNK_CHARS));
  const chunk = CHUNK_TARGETS.includes(target) ? chunkFor(target) : null;
  const anchors = typeof source?.SEARCH_ANCHOR_TEXT === "string" && source.SEARCH_ANCHOR_TEXT.trim() === "1";
  return { tokenizer, chunk, ...(anchors && { anchors: true }) };
}

/**
 * Whether this runtime can build and serve `format`: every value in range. The
 * default is always usable. Tokenizer 2 additionally needs a working
 * `Intl.Segmenter` (`segmenterSelfTest`, memoized per isolate; ruling OPEN-52):
 * a runtime that fails it neither writes nor queries a tokenizer-2 index, and
 * serves v2. The reader and the writer both go through `usesV3`, so this one
 * check gates both.
 */
export function formatUsable(format) {
  if (typeof format !== "object" || format === null) return false;
  if (!TOKENIZERS.includes(format.tokenizer)) return false;
  if (format.anchors !== undefined && format.anchors !== true) return false;
  if (format.tokenizer === 2 && !segmenterSelfTest()) return false;
  if (format.chunk === null) return true;
  const chunk = format.chunk;
  if (typeof chunk !== "object" || !CHUNK_TARGETS.includes(chunk.target)) return false;
  const expected = chunkFor(chunk.target);
  return chunk.max === expected.max && chunk.cap === expected.cap;
}

/** Two formats describe the same index. */
export function formatsEqual(a, b) {
  if (!formatUsable(a) || !formatUsable(b)) return false;
  return a.tokenizer === b.tokenizer && (a.chunk?.target ?? null) === (b.chunk?.target ?? null) &&
    (a.anchors === true) === (b.anchors === true);
}

/**
 * Whether `format` is read and written under `.context/search/v3/`: any usable
 * non-default format, or a usable one carrying `namespace: "v3"`. The second
 * form is the bench and test hook that builds tokenizer 1 without chunking in
 * the v3 namespace, so the namespace alone can be compared against v2;
 * `indexFormatFor` never sets it, so no deployment var reaches it.
 */
export function usesV3(format) {
  return formatUsable(format) && (format.namespace === "v3" || !formatsEqual(format, DEFAULT_FORMAT));
}

/**
 * A stored `format` field as a fresh format object, or `null` when it is not
 * one this build understands. A newer format is refused, never guessed at.
 */
export function readFormat(value) {
  if (!formatUsable(value)) return null;
  return {
    tokenizer: value.tokenizer,
    chunk: value.chunk === null ? null : chunkFor(value.chunk.target),
    ...(value.anchors === true && { anchors: true }),
  };
}
