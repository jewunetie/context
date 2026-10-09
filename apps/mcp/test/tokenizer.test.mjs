/**
 * The tokenizer, `termsOf` in `src/search/text.js` (P9, rulings OPEN-48 to
 * OPEN-52).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
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
 * the tokenizer correct if the stemmer's contract ever widens; the "non-Latin pieces
 * stemmed" row is the sabotage that shows other scripts reach the terms
 * unstemmed.
 *
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { generateCorpus } from "./fixtures/searchCorpus.js";
import { porter2 as porter2Module } from "../src/search/porter2.js";
import { porter2, segmenterSelfTest, termsOf } from "../src/search/text.js";

// SHA-256 of JSON.stringify of termsOf over every note then every query of
// generateCorpus({ size: 100 }). Any change to the tokenizer's output changes
// it, which is the point: an index built with other terms is never served
// (bump INDEX_FORMAT_VERSION in the same change).
const CORPUS_DIGEST = "9f5a4a1e1f6f0206a350b2f97e4bcc7db51e4e70876bc3d6450f2ef13ca95ca2";

const digest = (s) => createHash("sha256").update(s).digest("hex");

test("the tokenizer's output over the shared corpus is frozen", () => {
  const { notes, queries } = generateCorpus({ size: 100 });
  const terms = JSON.stringify([...notes.map((n) => termsOf(n.text)), ...queries.map((q) => termsOf(q.query))]);
  assert.equal(digest(terms), CORPUS_DIGEST);
});

test("porter2 is re-exported from text.js", () => {
  assert.equal(porter2, porter2Module);
});

test("non-string and empty input give no terms", () => {
  assert.deepEqual(termsOf(""), []);
  assert.deepEqual(termsOf(null), []);
  assert.deepEqual(termsOf(42), []);
});

test("Chinese: segmenter word and two-character piece", () => {
  const terms = termsOf("数据库迁移计划已经确认，下周开始执行。");
  const hits = terms.filter((t) => t === "迁移").length;
  assert.ok(hits >= 2, `迁移 as a segmenter word and as a piece, got ${JSON.stringify(terms)}`);
  // A piece never crosses the ideographic comma.
  assert.ok(!terms.includes("认下"));
  // Pieces cover the whole run, including pairs the segmenter split.
  assert.ok(terms.includes("库迁"));
});

test("Japanese: katakana word kept whole", () => {
  const terms = termsOf("来週のリリース計画を確認してください。");
  assert.ok(terms.includes("リリース"), JSON.stringify(terms));
});

test("Thai segments into several terms, none stemmed, marks kept", () => {
  const thai = "ฉันชอบกินข้าวมาก";
  const terms = termsOf(thai);
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(thai)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment)
    .filter((w) => w.length >= 2);
  assert.ok(terms.length > 1);
  assert.deepEqual(terms, words);
  assert.ok(terms.includes("ข้าว"), "the tone mark U+0E49 survives");
});

test("Cyrillic is lowercased and unstemmed", () => {
  assert.deepEqual(termsOf("Привет Мирам"), ["привет", "мирам"]);
});

test("accent folding on Latin letters only", () => {
  const cafe = termsOf("café Café cafe CAFÉ");
  assert.equal(new Set(cafe).size, 1, JSON.stringify(cafe));
  assert.deepEqual(termsOf("naïve"), termsOf("naive"));
});

test("a Devanagari word keeps its vowel sign", () => {
  const [term] = termsOf("हिंदी");
  assert.equal(term, "हिंदी");
  assert.ok(term.includes("ं"), "anusvara (Mn) kept");
});

test("Porter2 conflates deploying, deployed and deployment", () => {
  assert.deepEqual(termsOf("deploying deployed deployment"), ["deploy", "deploy", "deploy"]);
});

test("ASCII and typographic apostrophes both give gateway", () => {
  assert.deepEqual(termsOf("gateway's"), ["gateway"]);
  assert.deepEqual(termsOf("gateway’s"), ["gateway"]);
});

test("bench CODE identifiers emit whole and split forms", () => {
  assert.deepEqual(termsOf("Call `fetchUserProfile(userId)` before rendering."), [
    "call", "fetchuserprofile", "fetch", "user", "profil", "userid", "user", "id", "befor", "render",
  ]);
  assert.deepEqual(termsOf("invoice_total_cents"), ["invoice_total_cents", "invoic", "total", "cent"]);
  assert.deepEqual(termsOf("MAX_RETRY_COUNT"), ["max_retry_count", "max", "retri", "count"]);
  assert.deepEqual(termsOf("parseHttpHeader"), ["parsehttpheader", "pars", "http", "header"]);
});

test("dotted versions, acronyms and digits inside camelCase", () => {
  assert.deepEqual(termsOf("v2.3.1"), ["v2.3.1", "v2"]);
  assert.deepEqual(termsOf("XMLHttpRequest"), ["xmlhttprequest", "xml", "http", "request"]);
  assert.deepEqual(termsOf("base64Encode"), ["base64encode", "base", "64", "encod"]);
  assert.deepEqual(termsOf("Base64"), ["base64"], "no camel hump, not an identifier");
});

test("fullwidth letters equal ASCII", () => {
  assert.deepEqual(termsOf("ＡＢＣ"), ["abc"]);
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
    const zh = termsOf("数据库迁移计划已经确认，下周");
    assert.ok(zh.includes("数据库迁移计划已经确认"), "the regex run is one word");
    assert.ok(zh.includes("迁移") && zh.includes("下周"), JSON.stringify(zh));
    assert.deepEqual(termsOf("fetchUserProfile(userId) gateway’s"), [
      "fetchuserprofile", "fetch", "user", "profil", "userid", "user", "id", "gateway",
    ]);
  } finally {
    Intl.Segmenter = saved;
  }
  assert.equal(segmenterSelfTest(), true);
});
