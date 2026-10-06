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
 */

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
  return { tokenizer, chunk };
}

/**
 * Whether this build can build and serve `format`: every value in range. The
 * default is always usable. Task 35 adds the `Intl.Segmenter` gate here.
 */
export function formatUsable(format) {
  if (typeof format !== "object" || format === null) return false;
  if (!TOKENIZERS.includes(format.tokenizer)) return false;
  if (format.chunk === null) return true;
  const chunk = format.chunk;
  if (typeof chunk !== "object" || !CHUNK_TARGETS.includes(chunk.target)) return false;
  const expected = chunkFor(chunk.target);
  return chunk.max === expected.max && chunk.cap === expected.cap;
}

/** Two formats describe the same index. */
export function formatsEqual(a, b) {
  if (!formatUsable(a) || !formatUsable(b)) return false;
  return a.tokenizer === b.tokenizer && (a.chunk?.target ?? null) === (b.chunk?.target ?? null);
}

/**
 * A stored `format` field as a fresh format object, or `null` when it is not
 * one this build understands. A newer format is refused, never guessed at.
 */
export function readFormat(value) {
  if (!formatUsable(value)) return null;
  return { tokenizer: value.tokenizer, chunk: value.chunk === null ? null : chunkFor(value.chunk.target) };
}
