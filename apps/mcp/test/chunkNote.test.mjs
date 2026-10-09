/**
 * `chunkNote` in `src/search/chunk.js`: pure note chunking for search (P8).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   `max` check dropped (units never expanded)                    8
 *   one character lost at every chunk boundary after the first   11
 *   fence opening ignored (fence content split at blank lines)    2
 *   sentence fallback finds no sentence ends                      1
 *   cap drops one character (`slice(0, cap - 1)`)                 2
 *   heading no longer forces a new chunk                          3
 *
 * RED first: with `chunk.js` moved aside the file failed to load
 * (ERR_MODULE_NOT_FOUND), then it was restored and the tests written against
 * it passed after one CRLF fix (heading regex saw a trailing `\r`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { generateCorpus } from "./fixtures/searchCorpus.js";
import { chunkNote } from "../src/search/chunk.js";

const CAP = 64000;
const join = (r) => r.chunks.map((c) => c.text).join("");
const sentence = (i) => `Sentence number ${i} says something plain. `;
const para = (n) => Array.from({ length: n }, (_, i) => sentence(i)).join("").trimEnd();

function checkTiling(text, opts) {
  const r = chunkNote("n.md", text, opts);
  const capped = text.slice(0, opts?.cap ?? CAP);
  assert.equal(join(r), capped);
  let at = 0;
  for (const c of r.chunks) {
    assert.equal(c.start, at);
    assert.equal(c.text, capped.slice(c.start, c.end));
    at = c.end;
  }
  const max = opts?.max ?? Math.floor((opts?.target ?? 2000) * 1.5);
  for (const c of r.chunks) assert.ok(c.text.length <= max, `chunk ${c.index} is ${c.text.length} over ${max}`);
  return r;
}

test("concatenation equals the capped input for every bench fixture note", () => {
  const { notes } = generateCorpus({ size: 200, seed: 1 });
  for (const n of notes) checkTiling(n.text);
  for (const target of [1000, 2000, 4000]) checkTiling(notes.map((n) => n.text).join("\n\n"), { target });
});

test("concatenation holds on hand cases", () => {
  for (const t of ["", "x", "\n\n\n", "# a\n# b\n", "---\na: 1\n---\n# h\nbody", "```\nunclosed\n\n\n", "日本語。文章！です？\n\n".repeat(400), "a ".repeat(5000)]) checkTiling(t);
});

test("a 10,000-character paragraph splits at sentence boundaries, none over max", () => {
  const text = para(230);
  assert.ok(text.length > 9500);
  const r = checkTiling(text);
  assert.ok(r.chunks.length >= 4);
  for (const c of r.chunks.slice(0, -1)) assert.match(c.text, /\.\s*$/);
  for (const c of r.chunks.slice(1)) assert.match(c.text, /^Sentence/);
});

test("a single 5,000-character sentence splits at whitespace under max", () => {
  const text = "word ".repeat(1000).trimEnd() + ".";
  const r = checkTiling(text);
  assert.ok(r.chunks.length >= 2);
  for (const c of r.chunks.slice(0, -1)) assert.match(c.text, /\s$/);
  for (const c of r.chunks) assert.ok(c.text.length <= 3000);
});

test("a long unbroken token is hard-split at max", () => {
  const r = checkTiling("x".repeat(7000));
  assert.deepEqual(r.chunks.map((c) => c.text.length), [3000, 3000, 1000]);
});

test("headings start new chunks and headingPath nests", () => {
  const text = "# A\n\nintro\n\n## B\n\nbody b\n\n### C\n\nbody c\n\n## D\n\nbody d\n\n# E\n\nbody e\n";
  const r = checkTiling(text);
  assert.deepEqual(r.chunks.map((c) => c.headingPath), [["A"], ["A", "B"], ["A", "B", "C"], ["A", "D"], ["E"]]);
  for (const c of r.chunks) assert.match(c.text, /^#/);
});

test("text before the first heading has an empty headingPath", () => {
  const r = chunkNote("n.md", "lead\n\n# A\n\nx\n");
  assert.deepEqual(r.chunks.map((c) => c.headingPath), [[], ["A"]]);
});

test("a hash line inside a fence is not a heading", () => {
  const r = checkTiling("# A\n\n```sh\n# comment\n```\n");
  assert.equal(r.chunks.length, 1);
  assert.deepEqual(r.chunks[0].headingPath, ["A"]);
});

test("a code fence under max is never split, even across blank lines", () => {
  const fence = "```js\n" + ("const a = 1;\n\nconst b = 2;\n").repeat(70) + "```\n";
  assert.ok(fence.length < 3000 && fence.length > 1500);
  const text = para(40) + "\n\n" + fence + "\n" + para(40);
  const r = checkTiling(text);
  const at = text.indexOf(fence);
  assert.ok(r.chunks.some((c) => c.start <= at && c.end >= at + fence.length), "fence lies inside one chunk");
});

test("a fence over max is split (it alone exceeds max)", () => {
  const fence = "```\n" + "line of code here\n".repeat(400) + "```\n";
  const r = checkTiling(fence);
  assert.ok(r.chunks.length >= 3);
});

test("frontmatter is only in chunk 0", () => {
  const text = "---\ntitle: T\ntags: [a]\n---\n# H\n\n" + para(100) + "\n\n## Next\n\n" + para(100);
  const r = checkTiling(text);
  assert.ok(r.chunks.length > 2);
  assert.ok(r.chunks[0].text.startsWith("---\ntitle: T"));
  assert.equal(r.chunks.filter((c) => c.text.includes("title: T")).length, 1);
  assert.equal(r.chunks[0].start, 0);
});

test("cap: exactly cap long is not partial, one more is", () => {
  const a = chunkNote("n.md", "a ".repeat(100), { cap: 200 });
  assert.equal(a.partial, false);
  const b = chunkNote("n.md", "a ".repeat(100) + "b", { cap: 200 });
  assert.equal(b.partial, true);
  assert.equal(join(b), "a ".repeat(100));
});

test("default cap is 64,000", () => {
  assert.equal(chunkNote("n.md", "a ".repeat(32000)).partial, false);
  assert.equal(chunkNote("n.md", "a ".repeat(32000) + "b").partial, true);
});

test("CRLF input keeps offsets correct", () => {
  const text = "# A\r\n\r\n" + para(120).replace(/\. /g, ".\r\n") + "\r\n\r\n## B\r\n\r\nend\r\n";
  const r = checkTiling(text);
  assert.ok(r.chunks.length > 2);
  assert.deepEqual(r.chunks.at(-1).headingPath, ["A", "B"]);
  assert.equal(r.chunks.at(-1).text, "## B\r\n\r\nend\r\n");
});

test("the sentence fallback (Segmenter deleted) gives the same boundaries on ASCII", () => {
  const text = para(230);
  const withSeg = chunkNote("n.md", text).chunks.map((c) => [c.start, c.end]);
  const saved = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    assert.equal(typeof Intl.Segmenter, "undefined");
    const r = checkTiling(text);
    assert.deepEqual(r.chunks.map((c) => [c.start, c.end]), withSeg);
    const cjk = checkTiling("これは文です。次の文です！本当ですか？ ".repeat(300));
    assert.ok(cjk.chunks.length > 1);
  } finally {
    Intl.Segmenter = saved;
  }
});
