/**
 * `tokenizeV2` and the versioned `termsOf` in `src/search/text.js` (P9,
 * rulings OPEN-48 to OPEN-52).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   v1 output changed (terms under 3 characters dropped)          1
 *   Latin gate inverted (Porter2 on non-Latin, not on Latin)      5
 *   non-Latin pieces stemmed (last character dropped)             7
 *   identifier whole form not indexed                             3
 *   lowercase before identifier split                             3
 *   fold marks on every script                                    2
 *   Segmenter absence crashes (typeof guard and catch removed)    1
 *   fallback path throws                                          1
 *   no CJK two-character pieces                                   2
 *   U+2019 not normalized                                         1
 *   no NFKC                                                       1
 *   self-test skips the identifier check                          1
 *   self-test skips the 迁移 check                                1
 *   self-test memo never refreshed after Intl.Segmenter changes   2
 *
 * Not observable, by design: removing the Latin gate (Porter2 on every
 * piece) fails nothing, because `porter2` returns any word with a character
 * outside a-z and the apostrophe unchanged (its contract, tested in
 * porter2.test.mjs). The gate is kept because the brief names it and it keeps
 * v2 correct if the stemmer's contract ever widens; the "non-Latin pieces
 * stemmed" row is the sabotage that shows other scripts reach the terms
 * unstemmed.
 *
 * RED first: the file failed to load (text.js did not export porter2), then
 * every test passed against the implementation as first written.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { generateCorpus } from "./fixtures/searchCorpus.js";
import { porter2 as porter2Module } from "../src/search/porter2.js";
import { porter2, segmenterSelfTest, stem, termsOf, tokenize, tokenizeV2 } from "../src/search/text.js";

// SHA-256 of JSON.stringify of termsOf over every note then every query of
// generateCorpus({ size: 100 }), computed with text.js at 24d71be2 (before
// tokenizer v2 existed). Any change to version 1 output changes it.
const V1_CORPUS_DIGEST = "859297595a8edf6ca6e43cecdfc943c012469be4ad3c6b0281fcd17e31592f40";

const v1Corpus = (fn) => {
  const { notes, queries } = generateCorpus({ size: 100 });
  return JSON.stringify([...notes.map((n) => fn(n.text)), ...queries.map((q) => fn(q.query))]);
};
const digest = (s) => createHash("sha256").update(s).digest("hex");

test("version 1 is byte-identical to today on the bench corpus", () => {
  assert.equal(digest(v1Corpus((t) => termsOf(t))), V1_CORPUS_DIGEST);
  assert.equal(digest(v1Corpus((t) => termsOf(t, 1))), V1_CORPUS_DIGEST);
  assert.equal(digest(v1Corpus((t) => tokenize(t).map(stem))), V1_CORPUS_DIGEST);
});

test("version 1 keeps today's hand outputs", () => {
  const text = "Café naïve gateway’s fetchUserProfile 数据库迁移 ＡＢＣ running planned stories";
  const today = ["café", "naïve", "gateway", "fetchuserprofile", "数据库迁移", "ａｂｃ", "run", "plan", "story"];
  assert.deepEqual(termsOf(text), today);
  assert.deepEqual(termsOf(text, 1), today);
  assert.deepEqual(termsOf("", 1), []);
  assert.deepEqual(termsOf(null, 1), []);
});

test("version 2 is tokenizeV2 and unknown versions are refused", () => {
  const text = "Deploying fetchUserProfile 数据库迁移";
  assert.deepEqual(termsOf(text, 2), tokenizeV2(text));
  assert.throws(() => termsOf(text, 3), RangeError);
  assert.throws(() => termsOf(text, "2"), RangeError);
});

test("porter2 is re-exported from text.js", () => {
  assert.equal(porter2, porter2Module);
});

test("non-string and empty input give no terms", () => {
  assert.deepEqual(tokenizeV2(""), []);
  assert.deepEqual(tokenizeV2(null), []);
  assert.deepEqual(tokenizeV2(42), []);
});

test("Chinese: segmenter word and two-character piece", () => {
  const terms = tokenizeV2("数据库迁移计划已经确认，下周开始执行。");
  const hits = terms.filter((t) => t === "迁移").length;
  assert.ok(hits >= 2, `迁移 as a segmenter word and as a piece, got ${JSON.stringify(terms)}`);
  // A piece never crosses the ideographic comma.
  assert.ok(!terms.includes("认下"));
  // Pieces cover the whole run, including pairs the segmenter split.
  assert.ok(terms.includes("库迁"));
});

test("Japanese: katakana word kept whole", () => {
  const terms = tokenizeV2("来週のリリース計画を確認してください。");
  assert.ok(terms.includes("リリース"), JSON.stringify(terms));
});

test("Thai segments into several terms, none stemmed, marks kept", () => {
  const thai = "ฉันชอบกินข้าวมาก";
  const terms = tokenizeV2(thai);
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(thai)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment)
    .filter((w) => w.length >= 2);
  assert.ok(terms.length > 1);
  assert.deepEqual(terms, words);
  assert.ok(terms.includes("ข้าว"), "the tone mark U+0E49 survives");
});

test("Cyrillic is lowercased and unstemmed", () => {
  assert.deepEqual(tokenizeV2("Привет Мирам"), ["привет", "мирам"]);
});

test("accent folding on Latin letters only", () => {
  const cafe = tokenizeV2("café Café cafe CAFÉ");
  assert.equal(new Set(cafe).size, 1, JSON.stringify(cafe));
  assert.deepEqual(tokenizeV2("naïve"), tokenizeV2("naive"));
});

test("a Devanagari word keeps its vowel sign", () => {
  const [term] = tokenizeV2("हिंदी");
  assert.equal(term, "हिंदी");
  assert.ok(term.includes("ं"), "anusvara (Mn) kept");
});

test("Porter2 conflates deploying, deployed and deployment", () => {
  assert.deepEqual(tokenizeV2("deploying deployed deployment"), ["deploy", "deploy", "deploy"]);
});

test("ASCII and typographic apostrophes both give gateway", () => {
  assert.deepEqual(tokenizeV2("gateway's"), ["gateway"]);
  assert.deepEqual(tokenizeV2("gateway’s"), ["gateway"]);
});

test("bench CODE identifiers emit whole and split forms", () => {
  assert.deepEqual(tokenizeV2("Call `fetchUserProfile(userId)` before rendering."), [
    "call", "fetchuserprofile", "fetch", "user", "profil", "userid", "user", "id", "befor", "render",
  ]);
  assert.deepEqual(tokenizeV2("invoice_total_cents"), ["invoice_total_cents", "invoic", "total", "cent"]);
  assert.deepEqual(tokenizeV2("MAX_RETRY_COUNT"), ["max_retry_count", "max", "retri", "count"]);
  assert.deepEqual(tokenizeV2("parseHttpHeader"), ["parsehttpheader", "pars", "http", "header"]);
});

test("dotted versions, acronyms and digits inside camelCase", () => {
  assert.deepEqual(tokenizeV2("v2.3.1"), ["v2.3.1", "v2"]);
  assert.deepEqual(tokenizeV2("XMLHttpRequest"), ["xmlhttprequest", "xml", "http", "request"]);
  assert.deepEqual(tokenizeV2("base64Encode"), ["base64encode", "base", "64", "encod"]);
  assert.deepEqual(tokenizeV2("Base64"), ["base64"], "no camel hump, not an identifier");
});

test("fullwidth letters equal ASCII", () => {
  assert.deepEqual(tokenizeV2("ＡＢＣ"), ["abc"]);
});

test("segmenterSelfTest is true under Node", () => {
  assert.equal(segmenterSelfTest(), true);
});

test("segmenterSelfTest is false for a segmenter that splits identifiers or misses 迁移", () => {
  const saved = Intl.Segmenter;
  const fake = (pattern) =>
    class {
      segment(s) {
        return [...s.matchAll(pattern)].map((m) => ({ segment: m[0], index: m.index, isWordLike: true }));
      }
    };
  try {
    Intl.Segmenter = fake(/[A-Z]?[a-z]+|迁移|./g);
    assert.equal(segmenterSelfTest(), false, "fetchUserProfile split");
    Intl.Segmenter = fake(/[a-zA-Z]+|./g);
    assert.equal(segmenterSelfTest(), false, "no 迁移 segment");
    Intl.Segmenter = fake(/[a-zA-Z]+|迁移|./g);
    assert.equal(segmenterSelfTest(), true, "control: both checks met");
  } finally {
    Intl.Segmenter = saved;
  }
  assert.equal(segmenterSelfTest(), true);
});

test("without Intl.Segmenter: regex fallback, CJK pieces, self-test false", () => {
  assert.equal(segmenterSelfTest(), true);
  const saved = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    assert.equal(typeof Intl.Segmenter, "undefined");
    assert.equal(segmenterSelfTest(), false);
    const zh = tokenizeV2("数据库迁移计划已经确认，下周");
    assert.ok(zh.includes("数据库迁移计划已经确认"), "the regex run is one word");
    assert.ok(zh.includes("迁移") && zh.includes("下周"), JSON.stringify(zh));
    assert.deepEqual(tokenizeV2("fetchUserProfile(userId) gateway’s"), [
      "fetchuserprofile", "fetch", "user", "profil", "userid", "user", "id", "gateway",
    ]);
  } finally {
    Intl.Segmenter = saved;
  }
  assert.equal(segmenterSelfTest(), true);
});
