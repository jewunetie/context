/**
 * Tokenization for the search index: the one copy of the rules.
 *
 * Everything that turns note text or a query into terms lives here, because
 * an indexer and a query parser that tokenize differently produce an index
 * that can never be hit. See CONTRACT.md for the format these terms feed.
 *
 * The tokenizer (`termsOf`) is Porter2 on Latin-script words, identifier
 * splitting, accent folding for Latin, `Intl.Segmenter` words and CJK
 * two-character pieces. There is one tokenizer and no switch.
 */

import { porter2 } from "./porter2.js";

/**
 * The terms both the indexer and the query parser store (see `tokenizeWords`
 * below for the rules). Terms come back in document order with repeats.
 */
export function termsOf(text) {
  return tokenizeWords(text, { pieces: true });
}

/**
 * The terms a query is parsed into: `termsOf`, except that it emits segmenter
 * words only, never the CJK two-character pieces the index side adds for
 * recall (ruling OPEN-48). A query word the index never stored reaches those
 * pieces through the scorer's CJK fallback (`shardQuery.js`), required
 * together, instead of as loose terms.
 */
export function queryTermsOf(text) {
  return tokenizeWords(text, { pieces: false });
}

export { porter2 };

// Han, Hiragana, Katakana, plus the prolonged sound mark (U+30FC, script
// Common) so a katakana word like リリース stays one run (ruling OPEN-48).
const CJK_RUN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\u30FC]{2,}/gu;
const CAMEL = /\p{Ll}\p{N}*\p{Lu}/u;
const CASE_SPLIT = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
const DIGIT_SPLIT = /(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

let segmenter = { ctor: null, instance: null, selfTest: false };

/** The word segmenter, rebuilt only if `Intl.Segmenter` itself changed. */
function wordSegmenter() {
  const ctor = typeof Intl !== "undefined" ? Intl.Segmenter : undefined;
  if (segmenter.ctor !== ctor) {
    let instance = null;
    let selfTest = false;
    try {
      if (typeof ctor === "function") {
        instance = new ctor(undefined, { granularity: "word" });
        const words = (s) => [...instance.segment(s)].filter((w) => w.isWordLike).map((w) => w.segment);
        selfTest = words("数据库迁移计划已经确认").includes("迁移") && words("fetchUserProfile").join("|") === "fetchUserProfile";
      }
    } catch {
      instance = null;
      selfTest = false;
    }
    segmenter = { ctor, instance, selfTest };
  }
  return segmenter;
}

/**
 * True only when `Intl.Segmenter` exists and segments the fixed checks the way
 * the pinned workerd does. Memoized per isolate. A writer or reader whose
 * self-test fails serves and writes no index (ruling OPEN-52, Task 35): there
 * is no second tokenizer to fall back to.
 */
export function segmenterSelfTest() {
  return wordSegmenter().selfTest;
}

/** OPEN-49: strip nonspacing marks only where the base letter is Latin. */
function foldLatin(piece) {
  return piece.normalize("NFD").replace(/(\p{Script=Latin})\p{Mn}+/gu, "$1").normalize("NFC");
}

/** OPEN-50: the whole identifier (lowercased, unstemmed), then its parts. */
function splitWord(word) {
  if (!/[_.]/.test(word) && !CAMEL.test(word)) return { whole: null, parts: [word] };
  const parts = word.split(/[_.]/).flatMap((part) => {
    const byCase = part.split(CASE_SPLIT);
    return CAMEL.test(part) ? byCase.flatMap((p) => p.split(DIGIT_SPLIT)) : byCase;
  });
  return { whole: word.toLowerCase(), parts };
}

function termsOfPiece(piece) {
  const folded = foldLatin(piece.toLowerCase());
  if (folded.length < 2) return [];
  return [/^[a-z']+$/.test(folded) ? porter2(folded) : folded];
}

/**
 * The tokenizer (PLAN P9, rulings OPEN-48 to OPEN-52): NFKC and U+2019
 * to an ASCII apostrophe; `Intl.Segmenter` words (or `[\p{L}\p{N}_.']+` runs
 * when it is absent); identifier split on the original case; each piece
 * lowercased, Latin accents folded, length >= 2, Porter2 for Latin-script
 * pieces and other scripts unstemmed; every CJK run also yields overlapping
 * two-character pieces (unless `pieces: false`, the query side). Terms come
 * back in document order with repeats.
 */
function tokenizeWords(text, { pieces }) {
  if (typeof text !== "string" || !text) return [];
  const normal = text.normalize("NFKC").replace(/\u2019/g, "'");
  const { instance } = wordSegmenter();
  // lean: the Segmenter-less fallback is a stopgap with two known defects. It
  // has no combining marks (`\p{M}`), so Devanagari and Thai split at vowel
  // signs, and a sentence-final period sticks to its word, which can make a
  // plain word read as an identifier. Neither is fixed here because the index is
  // never written or queried when `segmenterSelfTest()` is false (Task 35):
  // this branch only runs for a caller of `termsOf` outside that gate. Upgrade
  // path: add `\p{M}` and trim trailing periods, only if a Segmenter-less
  // runtime must serve the index.
  const words = instance
    ? [...instance.segment(normal)].filter((s) => s.isWordLike).map((s) => ({ at: s.index, word: s.segment }))
    : [...normal.matchAll(/[\p{L}\p{N}_.']+/gu)].map((m) => ({ at: m.index, word: m[0] }));

  const located = [];
  for (const { at, word } of words) {
    const { whole, parts } = splitWord(word);
    if (whole && whole.length >= 2) located.push([at, whole]);
    for (const part of parts) for (const term of termsOfPiece(part)) located.push([at, term]);
  }
  if (pieces) for (const [at, piece] of locatedPieces(normal)) located.push([at, piece]);
  // Stable sort: a word's own terms stay ahead of a piece starting with it.
  return located.sort((a, b) => a[0] - b[0]).map(([, term]) => term);
}

/** `[offset, piece]` for every overlapping two-character piece of every CJK run. */
function locatedPieces(text) {
  const out = [];
  for (const run of text.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    let at = run.index;
    for (let i = 0; i + 1 < chars.length; i++) {
      out.push([at, chars[i] + chars[i + 1]]);
      at += chars[i].length;
    }
  }
  return out;
}

/**
 * The distinct CJK two-character pieces of one query term, in order: what the
 * index stored for that text besides its words. Empty for a term
 * with no CJK run.
 */
export function cjkPieces(term) {
  return typeof term === "string" ? [...new Set(locatedPieces(term).map(([, piece]) => piece))] : [];
}

/**
 * Character trigrams with boundary padding, for fuzzy vocabulary lookup.
 * "note" → ["  n", " no", "not", "ote", "te ", "e  "] deduplicated.
 */
export function trigrams(term) {
  if (typeof term !== "string" || !term) return [];
  const padded = `  ${term}  `;
  const grams = new Set();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return [...grams];
}
