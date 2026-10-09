/**
 * The irregular-forms layer (`search/irregular.js`) in front of Porter2.
 *
 * The tables are hand-written and not checked against an external source, so
 * these tests pin their shape (no chains, no duplicates, no entry Porter2
 * already covers), the ambiguous words that must stay unmerged, and that the
 * index side and both query paths reach the same term.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AMBIGUOUS, IRREGULAR, PLURALS, SPELLING, SPELLING_STEMS, VERBS, stemmed } from "../src/search/irregular.js";
import { porter2 } from "../src/search/porter2.js";
import { queryTermsOf, termsOf } from "../src/search/text.js";
import { seedQuery } from "../src/graph/retrieve.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { memoryBucket } from "./store/fixtures.mjs";

const split = (lines) => lines.map((line) => line.trim().split(/\s+/));
const irregularLines = split([...VERBS, ...PLURALS]);

test("table integrity: lowercase a-z keys, a different word each, no duplicates, no chains", () => {
  const keys = [];
  const bases = new Set();
  for (const [base, ...forms] of irregularLines) {
    assert.match(base, /^[a-z]+$/, base);
    assert.ok(forms.length > 0, `${base} lists no form`);
    bases.add(base);
    for (const form of forms) {
      assert.match(form, /^[a-z]+$/, form);
      assert.notEqual(form, base);
      keys.push(form);
    }
  }
  assert.equal(new Set(keys).size, keys.length, "a form is listed twice");
  assert.equal(IRREGULAR.size, keys.length);
  for (const [form, base] of IRREGULAR) {
    assert.notEqual(form, base);
    assert.equal(IRREGULAR.has(base), false, `${form} -> ${base} -> ${IRREGULAR.get(base)} is a chain`);
  }
  const bases2 = irregularLines.map(([base]) => base);
  assert.equal(new Set(bases2).size, bases2.length, "a base has two lines");
});

test("table integrity: no entry is one Porter2 already handles", () => {
  for (const [form, base] of IRREGULAR) assert.notEqual(porter2(form), porter2(base), `${form} already stems like ${base}`);
  for (const [uk, us] of split(SPELLING)) {
    assert.match(uk + us, /^[a-z]+$/);
    assert.notEqual(uk, us);
    assert.notEqual(porter2(uk), porter2(us), `${uk} already stems like ${us}`);
  }
  assert.equal(SPELLING_STEMS.size, SPELLING.length, "two pairs share a UK stem");
  for (const [uk, us] of SPELLING_STEMS) assert.equal(SPELLING_STEMS.has(us), false, `${uk} -> ${us} is a chain`);
});

test("table size: the hand-written lists are as large as the brief asked for", () => {
  assert.ok(VERBS.length >= 200, `${VERBS.length} verb lines`);
  assert.ok(PLURALS.length >= 50, `${PLURALS.length} plural lines`);
  assert.ok(SPELLING.length >= 80, `${SPELLING.length} spelling pairs`);
});

test("every listed form reaches the same term as its base", () => {
  for (const [form, base] of IRREGULAR) assert.deepEqual(termsOf(form), termsOf(base), `${form} / ${base}`);
  for (const [uk, us] of split(SPELLING)) {
    assert.deepEqual(termsOf(uk), termsOf(us), `${uk} / ${us}`);
    if (!/(s|x|ch|sh)$/.test(uk)) assert.deepEqual(termsOf(`${uk}s`), termsOf(`${us}s`), `${uk}s / ${us}s`);
  }
});

test("known forms", () => {
  const same = (a, b) => assert.deepEqual(termsOf(a), termsOf(b), `${a} / ${b}`);
  same("ran", "run");
  same("running", "ran");
  same("went", "go");
  same("goes", "went");
  same("was", "is");
  same("been", "be");
  same("bought", "buy");
  same("written", "wrote");
  same("write", "written");
  same("mice", "mouse");
  same("children", "child");
  same("children's", "child");
  same("feet", "foot");
  same("men", "man");
  same("people", "person");
  same("colour", "color");
  same("colours", "colored");
  same("coloured", "colouring");
  same("organised", "organization");
  same("analysing", "analyzed");
  same("centre", "centers");
  same("licence", "licensing");
  same("catalogue", "cataloguing");
  same("behavioural", "behaviors");
  same("defence", "defenses");
  same("Colour", "COLOR");
});

test("ambiguous forms stay what Porter2 alone gives, and are not in the table", () => {
  assert.ok(AMBIGUOUS.length >= 30);
  for (const [word, reason] of AMBIGUOUS) {
    assert.match(word, /^[a-z]+$/, word);
    assert.ok(reason.length > 10, `${word} has no reason`);
    assert.equal(IRREGULAR.has(word), false, `${word} must not be mapped`);
    assert.equal(SPELLING_STEMS.has(porter2(word)), false, `${word} must not be a spelling stem`);
    assert.deepEqual(termsOf(word), [porter2(word)], word);
  }
  const apart = (a, b) => assert.notDeepEqual(termsOf(a), termsOf(b), `${a} must not merge with ${b}`);
  apart("saw", "see");
  apart("found", "find");
  apart("left", "leave");
  apart("lay", "lie");
  apart("bear", "bore");
  apart("wound", "wind");
  apart("rose", "rise");
  apart("bound", "bind");
  apart("lives", "life");
  apart("leaves", "leaf");
});

test("only plain a-z and apostrophe input is looked up", () => {
  assert.equal(stemmed("ran"), "run");
  assert.deepEqual(termsOf("ränn"), ["rann"]);
  // The whole identifier token is never rewritten; its parts are.
  const terms = termsOf("ranTest");
  assert.ok(terms.includes("rantest") && terms.includes("run") && terms.includes("test"), terms.join(" "));
});

// -- search level ----------------------------------------------------------------

const NOW = Date.parse("2026-01-01T00:00:00Z");

function bucketWith(notes) {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2025-12-01T00:00:00Z");
    return listed;
  };
  for (const [path, text] of Object.entries(notes)) bucket.objects.set(path, { body: text, etag: `seed-${path}` });
  return bucket;
}

async function build(bucket) {
  for (let pass = 0; pass < 40; pass += 1) {
    const result = await syncShardedIndex(bucket, { budget: createSearchBudget(10_000), now: NOW });
    if (result.pending === 0 && !result.listingTruncated) return;
  }
  throw new Error("index did not converge");
}

async function find(bucket, query) {
  const found = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
  });
  return found.hits.map((hit) => hit.key).sort();
}

test("search: an irregular or UK form finds the note that has the other form", async () => {
  const bucket = bucketWith({
    "n/run.md": "# Morning habits\n\nI run every day and enjoy running before work.\n",
    "n/child.md": "# School\n\nThe child walks home alone.\n",
    "n/color.md": "# Palette\n\nPick a color for the header.\n",
    "n/organized.md": "# Filing\n\nWe organized the shelf.\n",
    "n/saw.md": "# Tools\n\nA hand saw cuts the plank.\n",
    "n/see.md": "# Eyes\n\nI see the sign.\n",
    "n/found.md": "# Company\n\nFound a startup in spring.\n",
    "n/find.md": "# Lost\n\nHelp me find the keys.\n",
  });
  await build(bucket);
  assert.deepEqual(await find(bucket, "ran"), ["n/run.md"]);
  assert.deepEqual(await find(bucket, "children"), ["n/child.md"]);
  assert.deepEqual(await find(bucket, "colour"), ["n/color.md"]);
  assert.deepEqual(await find(bucket, "colours"), ["n/color.md"]);
  assert.deepEqual(await find(bucket, "organised"), ["n/organized.md"]);
  assert.deepEqual(await find(bucket, "saw"), ["n/saw.md"]);
  assert.deepEqual(await find(bucket, "see"), ["n/see.md"]);
  assert.deepEqual(await find(bucket, "found"), ["n/found.md"]);
  assert.deepEqual(await find(bucket, "find"), ["n/find.md"]);
});

test("search: the index side maps too, so an irregular form in a note is found by its base", async () => {
  const bucket = bucketWith({ "n/a.md": "# Trip\n\nThe children ran to the car and went home.\n" });
  await build(bucket);
  assert.deepEqual(await find(bucket, "child"), ["n/a.md"]);
  assert.deepEqual(await find(bucket, "run"), ["n/a.md"]);
  assert.deepEqual(await find(bucket, "go"), ["n/a.md"]);
});

test("related-note seed query: irregular forms collapse to one query term", () => {
  const query = seedQuery({ path: "notes/a.md", body: "# Habits\n\nShe ran, runs and keeps running. The children colour mice.\n" }, "related_notes");
  const terms = queryTermsOf(query);
  assert.equal(terms.filter((term) => term === "run").length, 1, query);
  for (const term of [...termsOf("child"), ...termsOf("color"), ...termsOf("mouse")]) assert.ok(terms.includes(term), `${term} in ${terms.join(" ")}`);
  assert.deepEqual(queryTermsOf("ran"), termsOf("run"));
  assert.deepEqual(queryTermsOf("Colours"), termsOf("color"));
});
