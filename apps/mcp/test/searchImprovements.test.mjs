/**
 * Small tokenizer and indexer gaps closed after the irregular-forms layer:
 * title weight, joined identifiers, heading-hash stripping in linear time and
 * drawings past the 64,000-character cap. Each test pins one finding.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { compressToBase64 } from "../../../packages/drawings/src/lzstring.js";
import { subDocumentsFor } from "../src/search/commsIndex.js";
import { extractFields } from "../src/search/indexer.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { termsOf, queryTermsOf } from "../src/search/text.js";
import { memoryBucket } from "./store/fixtures.mjs";

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

/** Hit keys in rank order. */
async function ranked(bucket, query) {
  const found = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
  });
  return found.hits.map((hit) => hit.key);
}

test("B1: a query word in the title ranks above the same word repeated in a body", async () => {
  const filler = "plain filler words about nothing in particular written to take up room.";
  // The body note names the word more often than the title note does.
  const bucket = bucketWith({
    "n/a-body.md": `# Street notes\n\nThe zebra crossing was busy. A zebra was seen. Another zebra too. A zebra again. Zebra five. ${filler}\n`,
    "n/b-title.md": `# Zebra\n\n${filler} ${filler}\n`,
  });
  await build(bucket);
  assert.deepEqual(await ranked(bucket, "zebra"), ["n/b-title.md", "n/a-body.md"]);
});

test("B2: snake_case and dotted identifiers also yield the joined token, camelCase already does", async () => {
  for (const [text, whole, joined] of [
    ["call fooBarBaz now", "foobarbaz", "foobarbaz"],
    ["call foo_bar_baz now", "foo_bar_baz", "foobarbaz"],
    ["call config.file.path now", "config.file.path", "configfilepath"],
  ]) {
    const terms = termsOf(text);
    assert.ok(terms.includes(whole) && terms.includes(joined), `${text}: ${terms.join(" ")}`);
    for (const part of whole.split(/[_.]/).filter(Boolean)) if (/[a-z]{3}/.test(part)) assert.ok(terms.includes(part) || terms.includes(part.slice(0, -1)), part);
  }
  // Nothing is added where the join would be noise.
  assert.deepEqual(termsOf("e.g").filter((t) => t === "eg"), []);
  assert.deepEqual(termsOf("__init__").filter((t) => t === "init__"), []);
  assert.ok(!termsOf("version 1.2.3").includes("123"));
  const bucket = bucketWith({
    "n/snake.md": "# Notes\n\nCall fetch_user_profile before rendering.\n",
    "n/dotted.md": "# Notes\n\nSet config.file.path in the settings.\n",
    "n/apart.md": "# Notes\n\nThe fetch of a user and the profile page, plus the file path of a config.\n",
  });
  await build(bucket);
  assert.equal((await ranked(bucket, "fetchUserProfile"))[0], "n/snake.md");
  assert.deepEqual((await ranked(bucket, "fetchuserprofile")), ["n/snake.md"]);
  assert.equal((await ranked(bucket, "configFilePath"))[0], "n/dotted.md");
  assert.equal((await ranked(bucket, "fetch_user_profile"))[0], "n/snake.md");
  // Kebab names are split by the segmenter into words; the joined form is not indexed.
  assert.deepEqual(queryTermsOf("foo-bar-baz"), ["foo", "bar", "baz"]);
});

test("B3: closing hashes on a heading are stripped as before, in linear time", () => {
  const title = (heading) => extractFields("n/a.md", `# ${heading}\n`).title;
  assert.equal(title("Plan ##"), "Plan");
  assert.equal(title("Plan #"), "Plan");
  assert.equal(title("Plan \t ###"), "Plan");
  assert.equal(title("Plan#"), "Plan#");
  assert.equal(title("C#"), "C#");
  assert.equal(title("###"), "###");
  assert.equal(title("a #b ##"), "a #b");
  assert.equal(title("Plan # more"), "Plan # more");
  assert.equal(title("Plan  ## "), "Plan");
});

test("B3: pathological headings finish within a fixed bound", () => {
  const cases = [
    `# a${" ".repeat(50_000)}b\n`,
    `# a${"\t".repeat(50_000)}b\n`,
    `# a ${"#".repeat(50_000)}x\n`,
    `# a${" #".repeat(25_000)}x\n`,
    `# ${"#".repeat(50_000)}\n`,
    `## a${" ".repeat(50_000)}${"#".repeat(50_000)}\n`,
  ];
  for (const text of cases) {
    const start = performance.now();
    extractFields("n/a.md", text);
    const ms = performance.now() - start;
    assert.ok(ms < 250, `${ms.toFixed(0)} ms for ${text.slice(0, 12).replace(/\s/g, "_")}`);
  }
});

// -- B4: drawings past the 64,000-character cap ---------------------------------

/** A drawing whose labels live only in the payload, `count` elements long. */
function bigDrawing({ count, compressed, marked = { 1900: "zebrafinch" } }) {
  const elements = [];
  let state = 12345;
  const noise = () => Array.from({ length: 60 }, () => ((state = (state * 1103515245 + 12345) % 2147483648) >> 8).toString(36)).join("");
  for (let i = 0; i < count; i += 1) {
    elements.push({ noise: noise(), id: `el${i}`, type: "text", x: i, y: i, text: marked[i] ?? `ordinary label ${i}`, strokeColor: "#1e1e1e", seed: 12345 + i, link: marked[i] ? "[[notes/target]]" : null });
  }
  const json = JSON.stringify({ type: "excalidraw", elements }, null, 2);
  const fence = compressed ? "compressed-json" : "json";
  const payload = compressed ? compressToBase64(json) : json;
  return `---\nexcalidraw-plugin: parsed\ntags: [diagram]\n---\n# Excalidraw Data\n\n## Text Elements\nfirst label ^abc\n\n## Drawing\n\`\`\`${fence}\n${payload}\n\`\`\`\n`;
}

for (const compressed of [false, true]) {
  test(`B4: a ${compressed ? "compressed" : "plain"} drawing over the cap still indexes the labels past it`, async () => {
    const path = "d/big.excalidraw.md";
    const drawing = bigDrawing({ count: 2000, compressed });
    assert.ok(drawing.length > 64_000, `${drawing.length} characters`);
    const docs = subDocumentsFor(path, drawing);
    assert.equal(docs.length, 1);
    assert.ok(docs[0].content.length <= 64_000);
    const fields = extractFields(path, docs[0].content);
    assert.ok(fields.body.includes("zebrafinch") && fields.body.includes("ordinary label 1999"), "labels past the cut");
    assert.ok(fields.body.includes("first label"), "the Markdown half labels stay");
    assert.deepEqual(fields.tags, ["diagram"]);
    assert.equal(fields.title, "big");
    assert.deepEqual(fields.links, ["d/notes/target.md"]);
    assert.equal(docs[0].partial, undefined, "everything was read, so recall is not reduced");
    const bucket = bucketWith({ [path]: drawing, "n/other.md": "# Other\n\nnothing relevant here\n" });
    await build(bucket);
    assert.deepEqual(await ranked(bucket, "zebrafinch"), [path]);
  });
}

test("B4: a drawing past the element limit is still indexed, and reported as partial", () => {
  const drawing = bigDrawing({ count: 5100, compressed: false, marked: { 10: "earlyfinch", 5050: "latefinch" } });
  const [doc] = subDocumentsFor("d/huge.excalidraw.md", drawing);
  const body = extractFields("d/huge.excalidraw.md", doc.content).body;
  assert.ok(body.includes("earlyfinch") && !body.includes("latefinch"));
  assert.equal(doc.partial, true);
});

test("B4: a label that looks like a heading or the payload marker does not end the label list", () => {
  const drawing = bigDrawing({ count: 2000, compressed: false, marked: { 5: "# Not a heading", 6: "%%", 1900: "zebrafinch" } });
  const [doc] = subDocumentsFor("d/odd.excalidraw.md", drawing);
  assert.ok(extractFields("d/odd.excalidraw.md", doc.content).body.includes("zebrafinch"));
});
