/**
 * Tokenization for the search index — the one copy of the rules.
 *
 * Everything that turns note text or a query into terms lives here, because
 * an indexer and a query parser that tokenize differently produce an index
 * that can never be hit. See CONTRACT.md for the format these terms feed.
 *
 * The stemmer is a deliberately light suffix-stripper (an s-stemmer with the
 * two cheapest verb endings), not Porter: personal notes are full of names,
 * project slugs and code identifiers, and an aggressive stemmer conflates
 * exactly those. Every rule guards on length so short tokens pass untouched.
 * That is tokenizer version 1. Version 2 (`tokenizeV2`, Porter2 on Latin-script
 * words) is reached only through `termsOf(text, 2)`.
 */

import { porter2 } from "./porter2.js";

/**
 * The tokenizer version used when a caller names none: the gateway's default
 * and the app's local search read this one constant, so flipping it (Task 39,
 * owner-approved) flips both together.
 */
export const DEFAULT_TOKENIZER = 1;

/** Lowercased runs of Unicode letters/digits, length ≥ 2. */
export function tokenize(text) {
  if (typeof text !== "string" || !text) return [];
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  return matches.filter((token) => token.length >= 2);
}

/**
 * The terms both the indexer and the query parser store, for a tokenizer
 * version: 1 is tokenize + stem (today's index), 2 is `tokenizeV2`. Any other
 * value throws, so a version this code does not know is never read as 1.
 */
export function termsOf(text, tokenizer = DEFAULT_TOKENIZER) {
  if (tokenizer === 1) return tokenize(text).map(stem);
  if (tokenizer === 2) return tokenizeV2(text);
  throw new RangeError(`unknown tokenizer version ${tokenizer}`);
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
 * self-test fails must refuse tokenizer 2 (ruling OPEN-52, Task 35).
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
 * Tokenizer version 2 (PLAN P9, rulings OPEN-48 to OPEN-52): NFKC and U+2019
 * to an ASCII apostrophe; `Intl.Segmenter` words (or `[\p{L}\p{N}_.']+` runs
 * when it is absent); identifier split on the original case; each piece
 * lowercased, Latin accents folded, length >= 2, Porter2 for Latin-script
 * pieces and other scripts unstemmed; every CJK run also yields overlapping
 * two-character pieces. Terms come back in document order with repeats.
 */
export function tokenizeV2(text) {
  if (typeof text !== "string" || !text) return [];
  const normal = text.normalize("NFKC").replace(/\u2019/g, "'");
  const { instance } = wordSegmenter();
  const words = instance
    ? [...instance.segment(normal)].filter((s) => s.isWordLike).map((s) => ({ at: s.index, word: s.segment }))
    : [...normal.matchAll(/[\p{L}\p{N}_.']+/gu)].map((m) => ({ at: m.index, word: m[0] }));

  const located = [];
  for (const { at, word } of words) {
    const { whole, parts } = splitWord(word);
    if (whole && whole.length >= 2) located.push([at, whole]);
    for (const part of parts) for (const term of termsOfPiece(part)) located.push([at, term]);
  }
  for (const run of normal.matchAll(CJK_RUN)) {
    const chars = [...run[0]];
    let at = run.index;
    for (let i = 0; i + 1 < chars.length; i++) {
      located.push([at, chars[i] + chars[i + 1]]);
      at += chars[i].length;
    }
  }
  // Stable sort: a word's own terms stay ahead of a piece starting with it.
  return located.sort((a, b) => a[0] - b[0]).map(([, term]) => term);
}

/**
 * Pinned rules, applied top to bottom, first match wins:
 *   …'s → drop            (possessive survives tokenization as trailing "s"?
 *                          no — the apostrophe splits the token, so "gateway's"
 *                          tokenizes to ["gateway"] already; rule kept for
 *                          callers that stem un-tokenized words)
 *   ies → y   at length ≥ 5   (stories → story)
 *   sses → ss at length ≥ 5   (classes → class)
 *   ss  → keep                (class stays class)
 *   s   → drop at length ≥ 4  (notes → note; "das", "its" short enough to keep)
 *   ing → drop at length ≥ 6, un-double a doubled final consonant, and keep
 *         the original when the stem would fall under 3 (running → run)
 *   ed  → drop at length ≥ 5, same doubling rule (planned → plan)
 */
export function stem(token) {
  if (typeof token !== "string") return "";
  let t = token;
  if (t.endsWith("'s")) t = t.slice(0, -2);
  if (t.length >= 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length >= 5 && t.endsWith("sses")) return t.slice(0, -2);
  if (t.endsWith("ss")) return t;
  if (t.length >= 4 && t.endsWith("s")) return t.slice(0, -1);
  if (t.length >= 6 && t.endsWith("ing")) return unDouble(t.slice(0, -3), t);
  if (t.length >= 5 && t.endsWith("ed")) return unDouble(t.slice(0, -2), t);
  return t;
}

function unDouble(stemmed, original) {
  if (stemmed.length < 3) return original;
  const last = stemmed[stemmed.length - 1];
  if (last === stemmed[stemmed.length - 2] && /[bdfgklmnprt]/.test(last)) {
    return stemmed.slice(0, -1);
  }
  return stemmed;
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
