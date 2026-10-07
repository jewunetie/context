/**
 * Porter2 against Snowball's full published English vocabulary (OPEN-47).
 *
 * Fixtures: test/fixtures/snowball-english/{voc,output}.txt, copied unmodified (last change to english/voc.txt: commit ca1919d3, 2025-10-28)
 * from https://github.com/snowballstem/snowball-data (english/), BSD-3-Clause,
 * notice in test/fixtures/snowball-english/COPYING. Line i of output.txt is the
 * stem of line i of voc.txt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { porter2 } from "../src/search/porter2.js";

const read = (name) =>
  readFileSync(new URL(`fixtures/snowball-english/${name}`, import.meta.url), "utf8").trimEnd().split("\n");

test("porter2 matches Snowball output.txt for every word in voc.txt", () => {
  const words = read("voc.txt");
  const stems = read("output.txt");
  assert.equal(words.length, stems.length);
  assert.ok(words.length > 40000);
  const failures = [];
  words.forEach((w, i) => {
    const got = porter2(w);
    if (got !== stems[i]) failures.push(`${w}: got ${got}, want ${stems[i]}`);
  });
  assert.deepEqual(failures.slice(0, 50), [], `${failures.length} mismatches`);
});
