/**
 * CHUNKED SUB-DOCUMENTS AND THE 64,000-CHARACTER CAP IN THE SYNC (Task 36,
 * CONTRACT-v3.md "Chunked notes").
 *
 * Through `subDocumentsFor`, `indexVolumeOf` and a real build
 * (`syncShardedIndex`) plus `searchIndexedNotes` on a memory bucket with a
 * chunked format forced on the store: an ordinary note is one document per
 * `chunkNote` chunk, every chunk titled by the note, the last chunk of a note
 * past the cap marked partial and reported as reduced recall to the callers
 * who can see that note and nobody else.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   chunk `anchor` set to `c<n>`; the snippet-time drop is the `wallaby`  3
 *   hit vanishing in the 64,000 test (the others fail on the field)
 *   docmap version dropped for chunk docs                                  2
 *   `partial` not kept when a shard is reloaded                            1
 *   `partialPaths` not written to the manifest                             3
 *   `partialPaths` left out of `shedNotePathsOf`                           2
 *   `partial` on every chunk, not the last                                 1
 *   no title line on later chunks                                          2
 *   `indexVolumeOf` ignores the format                                     1
 *
 * RED first: 7 of 13 failed; the 6 that passed pin behaviour that must not
 * change (channel-day and `chunk: null` documents, an empty or encrypted note's
 * single document, removal of old chunk docs, convergence of Task 31's
 * chunking without `partial`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { syncShardedIndex, loadShard, loadIndexManifest } from "../src/search/shards.js";
import { createSearchBudget, NOTE_INDEX_CHAR_CAP } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { subDocumentsFor, indexVolumeOf, channelDaySubDocuments } from "../src/search/commsIndex.js";
import { chunkNote } from "../src/search/chunk.js";
import { DEFAULT_FORMAT } from "../src/search/format.js";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { memoryBucket } from "./store/fixtures.mjs";

const CHUNKED = { tokenizer: 1, chunk: { target: 2000, max: 3000, cap: 64_000 } };
const NOW = Date.parse("2026-01-01T00:00:00Z");
const V3_DOCMAP = ".context/search/v3/docmap.json";

/** `# title`, then ~400-character paragraphs to `length`; `marks` places a word at a character offset. */
function longNote(title, length, marks = {}) {
  const paragraph = "plain filler words about nothing in particular, written to take up room. ".repeat(6);
  let text = `# ${title}\n\n`;
  const pending = Object.entries(marks).sort((a, b) => a[1] - b[1]);
  while (text.length < length) {
    let next = paragraph;
    while (pending.length && pending[0][1] < text.length + next.length) next = `${pending.shift()[0]} ${next}`;
    text += `${next.trim()}\n\n`;
  }
  return text;
}

const MID = longNote("Field notes", 20_000, { zanzibar: 15_000 });
const HUGE = longNote("Expedition log", 70_000, { wallaby: 30_000, quokka: 66_000 });

function bucketWith(notes, format = CHUNKED) {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2025-12-01T00:00:00Z");
    return listed;
  };
  for (const [path, text] of Object.entries(notes)) bucket.objects.set(path, { body: text, etag: `seed-${path}` });
  bucket.searchIndexFormat = format;
  return bucket;
}

function sync(bucket) {
  return syncShardedIndex(bucket, { budget: createSearchBudget(10_000), now: NOW });
}

async function build(bucket) {
  for (let pass = 0; pass < 40; pass += 1) {
    const result = await sync(bucket);
    if (result.pending === 0 && !result.listingTruncated) return;
  }
  throw new Error("index did not converge");
}

function search(bucket, query, isVisible = () => true) {
  return searchIndexedNotes(bucket, {
    isVisible,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
  });
}

async function servedManifest(bucket) {
  return loadIndexManifest(bucket, createSearchBudget(1000), 0);
}

/** Every doc of the served index, as `[key, doc]`. */
async function storedDocs(bucket) {
  const budget = createSearchBudget(1000);
  const manifest = await servedManifest(bucket);
  const docs = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const shard = await loadShard(bucket, budget, 0, id, undefined, manifest);
    if (shard) docs.push(...shard.docs.entries());
  }
  return docs;
}

async function storedTerms(bucket) {
  const budget = createSearchBudget(1000);
  const manifest = await servedManifest(bucket);
  const terms = new Set();
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const shard = await loadShard(bucket, budget, 0, id, undefined, manifest);
    if (shard) for (const term of shard.terms.keys()) terms.add(term);
  }
  return terms;
}

/** The v3 docmap's recorded version per note path. */
function docmapVersions(bucket) {
  const docmap = JSON.parse(bucket.objects.get(V3_DOCMAP).body);
  const versions = new Map();
  for (const shard of docmap.docsByShard) for (const [path, version] of shard) versions.set(path, version);
  return versions;
}

// -- the documents one note contributes -------------------------------------

test("a 20,000-character note is about ten chunk documents, each titled by the note", () => {
  const docs = subDocumentsFor("notes/mid.md", MID, CHUNKED);
  const { chunks } = chunkNote("notes/mid.md", MID, CHUNKED.chunk);
  assert.ok(docs.length >= 8 && docs.length <= 12, `${docs.length} docs`);
  assert.equal(docs.length, chunks.length);
  docs.forEach((doc, i) => {
    assert.equal(doc.key, `notes/mid.md#c${i}`);
    assert.equal(doc.notePath, "notes/mid.md");
    assert.equal(doc.anchor, null);
    assert.equal(doc.chunk, i);
    assert.equal(doc.comms, null);
    assert.equal(doc.partial, undefined, "a note under the cap has no partial chunk");
    assert.ok(doc.content.endsWith(chunks[i].text));
  });
  assert.equal(docs[0].content, chunks[0].text, "chunk 0 is the chunk text alone");
  assert.ok(docs[3].content.startsWith("# Field notes\n"), "a later chunk leads with the note's first heading");
});

test("only the last chunk of a note past the cap is partial", () => {
  const docs = subDocumentsFor("notes/huge.md", HUGE, CHUNKED);
  assert.deepEqual(docs.filter((doc) => doc.partial).map((doc) => doc.chunk), [docs.length - 1]);
  assert.equal(docs[docs.length - 1].partial, true);
  assert.ok(!docs.some((doc) => doc.content.includes("quokka")), "nothing past 64,000 characters is indexed");
});

test("a note with no heading gets no title line on its later chunks", () => {
  const text = longNote("x", 9_000).replace(/^# x\n\n/, "");
  const docs = subDocumentsFor("notes/bare.md", text, CHUNKED);
  const { chunks } = chunkNote("notes/bare.md", text, CHUNKED.chunk);
  assert.ok(docs.length > 1);
  assert.deepEqual(docs.map((doc) => doc.content), chunks.map((chunk) => chunk.text));
});

test("a channel-day note produces exactly today's message documents", () => {
  const msg = (i) => ({
    channel: "email",
    account: "name-at-example-com",
    messageId: `<m${i}@mail.example.net>`,
    threadId: `thread-${i}`,
    sentAt: new Date(Date.UTC(2026, 8, 7, 9, i)).toISOString(),
    subject: `Subject ${i}`,
    from: { name: "Fake Sender", address: "sender@example.net" },
    to: [{ address: "name@example.com" }],
    body: `the wombat report part ${i} ${"long body ".repeat(400)}`,
    attachments: [],
  });
  const day = renderChannelDayNote({
    channel: "email",
    account: "name-at-example-com",
    address: "name@example.com",
    date: "2026-09-07",
    nonce: "0123456789abcdef",
    now: "2026-09-07T18:04:11.221Z",
    events: [msg(0), msg(1), msg(2)],
  });
  const path = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const today = subDocumentsFor(path, day);
  assert.equal(today.length, 3);
  assert.deepEqual(subDocumentsFor(path, day, CHUNKED), today);
  assert.deepEqual(today, channelDaySubDocuments(path, day));
});

test("with chunk: null every document equals today's", () => {
  for (const [path, text] of [["notes/huge.md", HUGE], ["notes/mid.md", MID], ["notes/empty.md", ""], ["notes/short.md", "# Hi\n\nthere"]]) {
    const today = subDocumentsFor(path, text);
    assert.deepEqual(today, [{ key: path, notePath: path, anchor: null, content: text.slice(0, NOTE_INDEX_CHAR_CAP), comms: null }]);
    assert.deepEqual(subDocumentsFor(path, text, DEFAULT_FORMAT), today);
    assert.deepEqual(subDocumentsFor(path, text, { tokenizer: 2, chunk: null }), today);
  }
});

test("an empty note under a chunked format keeps its one whole-note document", () => {
  assert.deepEqual(subDocumentsFor("notes/empty.md", "", CHUNKED), subDocumentsFor("notes/empty.md", ""));
});

test("sizing: a 50,000-byte ordinary note counts 50,000 chunked and 2,048 without", () => {
  assert.equal(indexVolumeOf("notes/big.md", 50_000, CHUNKED), 50_000);
  assert.equal(indexVolumeOf("notes/big.md", 50_000, DEFAULT_FORMAT), 2048);
  assert.equal(indexVolumeOf("notes/big.md", 50_000), 2048);
  assert.equal(indexVolumeOf("notes/big.md", 200_000, CHUNKED), 64_000, "capped at the format's cap");
  // A size the listing did not report reads as one per-note window, as today.
  assert.equal(indexVolumeOf("notes/big.md", undefined, CHUNKED), NOTE_INDEX_CHAR_CAP);
  // Channel-day notes are counted by their bytes whatever the format.
  const day = "0-inbox/email/name-at-example-com/2026-09-07.md";
  assert.equal(indexVolumeOf(day, 50_000, CHUNKED), indexVolumeOf(day, 50_000));
});

// -- through the sync and search ----------------------------------------------

test("a built chunked index stores every chunk under the note's path and version, and finds a term at 15,000", async () => {
  const bucket = bucketWith({ "notes/mid.md": MID, "notes/other.md": "# Other\n\nunrelated" });
  await build(bucket);
  const docs = (await storedDocs(bucket)).filter(([, doc]) => doc.notePath === "notes/mid.md");
  const expected = chunkNote("notes/mid.md", MID, CHUNKED.chunk).chunks.length;
  assert.equal(docs.length, expected);
  assert.ok(docs.length >= 8 && docs.length <= 12);
  const versions = new Set(docs.map(([, doc]) => doc.etag));
  assert.equal(versions.size, 1, "every chunk carries the same version");
  assert.equal(docmapVersions(bucket).get("notes/mid.md"), [...versions][0], "the docmap records that version");
  for (const [key, doc] of docs) {
    assert.equal(doc.title, "Field notes", `${key} title`);
    assert.equal(doc.anchor, null);
  }
  const answer = await search(bucket, "zanzibar");
  assert.deepEqual(answer.hits.map((hit) => hit.key), ["notes/mid.md"]);
  assert.ok(answer.hits[0].snippets.some((line) => line.includes("zanzibar")));
  assert.equal(answer.reducedRecall, false);
});

test("a term past 64,000 is not found, and the note is reduced recall only for callers who can see it", async () => {
  const path = "2-areas/vault/huge.md";
  const bucket = bucketWith({ [path]: HUGE, "notes/open.md": "# Open\n\nan open note" });
  await build(bucket);
  assert.ok(!(await storedTerms(bucket)).has("quokka"));
  const owner = await search(bucket, "quokka");
  assert.deepEqual(owner.hits.map((hit) => hit.key), []);
  assert.equal(owner.reducedRecall, true);
  assert.deepEqual(owner.reducedRecallNotes, [path]);
  const found = await search(bucket, "wallaby");
  assert.deepEqual(found.hits.map((hit) => hit.key), [path]);
  const outsider = await search(bucket, "quokka", (key) => !key.startsWith("2-areas/vault/"));
  assert.deepEqual(outsider.reducedRecallNotes, []);
  assert.equal(outsider.reducedRecall, false);
  assert.ok(!JSON.stringify(outsider).includes("vault"), "the hidden note's path never reaches the outsider");
  const manifest = await servedManifest(bucket);
  assert.deepEqual(manifest.stats.flatMap((entry) => entry.partialPaths), [path]);
  assert.deepEqual(manifest.stats.flatMap((entry) => entry.shedPaths), [], "partial is not shed");
});

test("the diff converges: a second pass over chunked and capped notes changes nothing", async () => {
  const bucket = bucketWith({ "notes/mid.md": MID, "notes/huge.md": HUGE });
  await build(bucket);
  const before = new Map([...bucket.objects].filter(([key]) => key.startsWith(".context/search/v3/shards/")));
  const again = await sync(bucket);
  assert.equal(again.pending, 0);
  assert.equal(again.changed, false);
  const after = [...bucket.objects.keys()].filter((key) => key.startsWith(".context/search/v3/shards/"));
  assert.deepEqual(after.sort(), [...before.keys()].sort(), "no new shard revision");
});

test("editing a note to fewer chunks removes its old chunk documents", async () => {
  const bucket = bucketWith({ "notes/mid.md": MID });
  await build(bucket);
  const shorter = longNote("Field notes", 4_000, { zanzibar: 3_000 });
  bucket.objects.set("notes/mid.md", { body: shorter, etag: "edited" });
  await build(bucket);
  const keys = (await storedDocs(bucket)).filter(([, doc]) => doc.notePath === "notes/mid.md").map(([key]) => key).sort();
  const expected = chunkNote("notes/mid.md", shorter, CHUNKED.chunk).chunks.map((_, i) => `notes/mid.md#c${i}`).sort();
  assert.ok(expected.length < 8);
  assert.deepEqual(keys, expected);
});

test("a note shortened under the cap stops being reported as reduced recall", async () => {
  const bucket = bucketWith({ "notes/huge.md": HUGE });
  await build(bucket);
  assert.deepEqual((await search(bucket, "quokka")).reducedRecallNotes, ["notes/huge.md"]);
  bucket.objects.set("notes/huge.md", { body: MID, etag: "edited" });
  await build(bucket);
  assert.deepEqual((await search(bucket, "zanzibar")).reducedRecallNotes, []);
});

test("an encrypted note teaches a chunked index no plaintext term", async () => {
  const sealed = `---\ncontext_encryption: v1\n---\n${"ciphertext kestrel blob. ".repeat(1500)}`;
  const bucket = bucketWith({ "notes/sealed.md": sealed, "notes/open.md": "# Open\n\nnothing here" });
  await build(bucket);
  const terms = await storedTerms(bucket);
  assert.ok(!terms.has("kestrel") && !terms.has("ciphertext"));
  const docs = (await storedDocs(bucket)).filter(([, doc]) => doc.notePath === "notes/sealed.md");
  assert.deepEqual(docs.map(([key]) => key), ["notes/sealed.md"], "one whole-note document, so its version is recorded");
  assert.deepEqual((await search(bucket, "kestrel")).hits, []);
});
