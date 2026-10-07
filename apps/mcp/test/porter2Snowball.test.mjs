/**
 * Porter2 against Snowball's full published English vocabulary (OPEN-47).
 *
 * Fixtures: test/fixtures/snowball-english/, a lossless split of snowball-data
 * english/voc.txt and output.txt (BSD-3-Clause; source URLs in README.md,
 * notice in COPYING). voc/NAME.txt and output/NAME.txt pair line for line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { porter2 } from "../src/search/porter2.js";

const dir = new URL("fixtures/snowball-english/", import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), "utf8").trimEnd().split("\n");

test("porter2 matches Snowball output for every word in the vocabulary", () => {
  const names = readdirSync(new URL("voc/", dir)).sort();
  assert.deepEqual(readdirSync(new URL("output/", dir)).sort(), names);
  const words = [];
  const stems = [];
  for (const name of names) {
    const w = read(`voc/${name}`);
    const s = read(`output/${name}`);
    assert.equal(w.length, s.length, name);
    words.push(...w);
    stems.push(...s);
  }
  assert.equal(words.length, 42649);
  assert.equal(new Set(words).size, words.length, "a word appears twice");
  const failures = [];
  words.forEach((w, i) => {
    const got = porter2(w);
    if (got !== stems[i]) failures.push(`${w}: got ${got}, want ${stems[i]}`);
  });
  assert.deepEqual(failures.slice(0, 50), [], `${failures.length} mismatches`);
});
