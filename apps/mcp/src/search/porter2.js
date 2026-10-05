/**
 * Porter2, the Snowball English stemmer, for Latin-script words.
 *
 * Implements the algorithm as published at
 * https://snowballstem.org/algorithms/english/stemmer.html, fetched 2026-10-04
 * (HTTP Last-Modified: Thu, 20 Aug 2026 22:45:07 GMT). The page is headed
 * "Revised slightly, December 2001; Further revised, September 2002" and its
 * revision notes run through "Snowball 3.1.0": restored exception for skis,
 * R1 exception for words starting inter. Earlier notes it lists and this file
 * follows: logi to log, bli to ble, two-letter words untouched, ative only in
 * R2, herring exception, commun and arsen prefixes, Step 0 for apostrophes,
 * ied/ies to ie after one letter, initial y always a consonant, no undoubling
 * after exactly a, e or o, the evening exception, the past, univers, later,
 * emerg and organ prefixes, ogist to og, and the eed and ing exceptions
 * handled inside Step 1b (this version has no separate post-Step-1a list).
 *
 * Not wired into text.js, the indexer or any query path: PLAN.md decision P9
 * swaps it in behind a switch after benchmarking.
 *
 * Contract: one lowercase word in, its stem out. A string with a character
 * outside a-z and the apostrophe is returned unchanged, so the function is
 * total over strings and never throws. The page defines no other apostrophe
 * normalization, so none is done here.
 */

const EXCEPTIONS = new Map([
  ["skis", "ski"], ["skies", "sky"],
  ["idly", "idl"], ["gently", "gentl"], ["ugly", "ugli"],
  ["early", "earli"], ["only", "onli"], ["singly", "singl"],
  ["sky", "sky"], ["news", "news"], ["howe", "howe"],
  ["atlas", "atlas"], ["cosmos", "cosmos"], ["bias", "bias"], ["andes", "andes"],
]);

const R1_PREFIXES = ["gener", "commun", "arsen", "past", "univers", "later", "emerg", "organ", "inter"];

const byLength = (rules) => rules.sort((a, b) => b[0].length - a[0].length);

// [suffix, replacement, allowed preceding letters?, "R2" if R2 is required]
const STEP2 = byLength([
  ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["abli", "able"],
  ["entli", "ent"], ["izer", "ize"], ["ization", "ize"],
  ["ational", "ate"], ["ation", "ate"], ["ator", "ate"],
  ["alism", "al"], ["aliti", "al"], ["alli", "al"], ["fulness", "ful"],
  ["ousli", "ous"], ["ousness", "ous"], ["iveness", "ive"], ["iviti", "ive"],
  ["biliti", "ble"], ["bli", "ble"], ["ogist", "og"], ["ogi", "og", "l"],
  ["fulli", "ful"], ["lessli", "less"], ["li", "", "cdeghkmnrt"],
]);

const STEP3 = byLength([
  ["tional", "tion"], ["ational", "ate"], ["alize", "al"],
  ["icate", "ic"], ["iciti", "ic"], ["ical", "ic"],
  ["ful", ""], ["ness", ""], ["ative", "", null, "R2"],
]);

const STEP4 = byLength([
  ...["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
    "ment", "ent", "ism", "ate", "iti", "ous", "ive", "ize"].map((s) => [s, ""]),
  ["ion", "", "st"],
]);

function isVowel(c) {
  return c !== undefined && "aeiouy".includes(c);
}

function hasVowel(s) {
  for (const c of s) if (isVowel(c)) return true;
  return false;
}

/** Index just past the first non-vowel that follows a vowel, at or after `from`. */
function regionStart(w, from) {
  let i = from;
  while (i < w.length && !isVowel(w[i])) i++;
  i++;
  while (i < w.length && isVowel(w[i])) i++;
  return Math.min(i + 1, w.length);
}

/** Does w.slice(0, end) end in a short syllable (page definition, Snowball shortv)? */
function endsShort(w, end) {
  const [a, b, c] = [w[end - 3], w[end - 2], w[end - 1]];
  if (end >= 3 && !isVowel(a) && isVowel(b) && !isVowel(c) && !"wxY".includes(c)) return true;
  if (end === 2 && isVowel(b) && !isVowel(c)) return true;
  return w.slice(0, end).endsWith("past");
}

/** Longest matching suffix only; if its region or condition fails, nothing happens. */
function applyLongest(w, rules, r1, r2) {
  for (const [suffix, replacement, before, region] of rules) {
    if (!w.endsWith(suffix)) continue;
    const start = w.length - suffix.length;
    if (start < (region === "R2" ? r2 : r1)) return w;
    if (before && (start === 0 || !before.includes(w[start - 1]))) return w;
    return w.slice(0, start) + replacement;
  }
  return w;
}

function step1b(w, p1) {
  const suffix = ["eedly", "ingly", "edly", "eed", "ing", "ed"].find((s) => w.endsWith(s));
  if (!suffix) return w;
  const pre = w.slice(0, w.length - suffix.length);
  if (suffix === "eed" || suffix === "eedly") {
    if (pre.length < p1 || pre === "proc" || pre === "exc" || pre === "succ") return w;
    return `${pre}ee`;
  }
  if (suffix === "ing") {
    if (pre.length === 2 && pre[1] === "y" && !isVowel(pre[0])) return `${pre[0]}ie`;
    if (["inn", "out", "cann", "herr", "earr", "even"].includes(pre)) return w;
  }
  if (!hasVowel(pre)) return w;
  if (/(at|bl|iz)$/.test(pre)) return `${pre}e`;
  if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(pre)) {
    return pre.length === 3 && "aeo".includes(pre[0]) ? pre : pre.slice(0, -1);
  }
  if (pre.length === p1 && endsShort(pre, pre.length)) return `${pre}e`;
  return pre;
}

export function porter2(word) {
  if (typeof word !== "string" || !/^[a-z']*$/.test(word)) return word;
  const exception = EXCEPTIONS.get(word);
  if (exception !== undefined) return exception;
  if (word.length <= 2) return word;

  // Prelude: drop one initial apostrophe, mark initial y and y after a vowel as Y.
  const raw = word[0] === "'" ? word.slice(1) : word;
  let w = "";
  for (let i = 0; i < raw.length; i++) {
    w += raw[i] === "y" && (i === 0 || isVowel(w[i - 1])) ? "Y" : raw[i];
  }

  const prefix = R1_PREFIXES.find((p) => w.startsWith(p));
  const p1 = prefix ? prefix.length : regionStart(w, 0);
  const p2 = regionStart(w, p1);

  // Step 0
  const apostrophe = ["'s'", "'s", "'"].find((s) => w.endsWith(s));
  if (apostrophe) w = w.slice(0, w.length - apostrophe.length);

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ied") || w.endsWith("ies")) w = w.slice(0, -3) + (w.length - 3 >= 2 ? "i" : "ie");
  else if (w.endsWith("us") || w.endsWith("ss")) { /* unchanged */ }
  else if (w.endsWith("s") && hasVowel(w.slice(0, Math.max(0, w.length - 2)))) w = w.slice(0, -1);

  w = step1b(w, p1);

  // Step 1c
  const n = w.length;
  if (n > 2 && (w[n - 1] === "y" || w[n - 1] === "Y") && !isVowel(w[n - 2])) w = `${w.slice(0, -1)}i`;

  w = applyLongest(w, STEP2, p1, p2);
  w = applyLongest(w, STEP3, p1, p2);
  w = applyLongest(w, STEP4, p2, p2);

  // Step 5
  const last = w.length - 1;
  if (w[last] === "e" && (last >= p2 || (last >= p1 && !endsShort(w, last)))) w = w.slice(0, -1);
  else if (w[last] === "l" && last >= p2 && w[last - 1] === "l") w = w.slice(0, -1);

  return w.replace(/Y/g, "y");
}
