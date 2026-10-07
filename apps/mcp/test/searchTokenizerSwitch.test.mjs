/**
 * TOKENIZER ON BOTH SIDES, AND CHUNK-AWARE RANKING (Task 33, CONTRACT-v3.md
 * "Queries and chunked results").
 *
 * Through a real build (`syncShardedIndex`) and `searchIndexedNotes` on a
 * memory bucket with the format forced on the store: a tokenizer 2 index is
 * queried with tokenizer 2 words only (never the CJK two-character pieces the
 * indexer adds), a CJK word the index never stored falls back to its pieces
 * required together, and a chunked note is one result whatever number of its
 * chunks match (README 12.5: counts are notes).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file, except the last row, which fails `searchV2Frozen.test.mjs`.
 *
 *   query parsed and scored with tokenizer 1 against a tokenizer 2 index   1
 *   query side emits the CJK two-character pieces                          2
 *   CJK fallback disabled                                                  1
 *   CJK fallback pieces not required together (any piece credits)          1
 *   fallback rung never runs (pieces never read)                           3
 *   pieces routed for every CJK term, found or not (fix round 1)           1
 *   re-read shard collected in full, N and df counted twice (fix round 1)  1
 *   piece routing ignores the filters, reads every shard (fix round 1)     1
 *   no per-note dedupe of chunk docs                                       6
 *   dedupe also applied to channel-day message docs                        1
 *   kept chunk does not carry the union of matched terms                   1
 *   result cap counts chunk docs, not notes                                1
 *   `chunk` field dropped by the shard serializer                          6
 *   `chunk` written on every doc (`"chunk":null`), frozen digest           1
 *
 * Not observable, by design: deduping before the visibility filter fails
 * nothing. Visibility is decided on `notePath` and every chunk of a note
 * shares it, so a note's chunks are all kept or all dropped and the order of
 * the two steps cannot change the answer (the folder `prefix` likewise, since
 * `path#c<n>` starts with a folder exactly when `path` does). The dedupe stays
 * after the filter because the ruling puts it there and the privacy test
 * below still pins the outcome.
 *
 * RED first: 9 of 12 failed (no words-only query mode, no fallback, chunk
 * docs not deduped or capped by note, `chunk` not stored); the 3 that passed
 * pin tokenizer 1 and channel-day behaviour that must not change.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { syncShardedIndex, loadShard, loadIndexManifest } from "../src/search/shards.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { parseQuery } from "../src/search/query.js";
import { termsOf } from "../src/search/text.js";
import { readTermFilter, termFilterMayHold } from "../src/search/filter.js";
import { readFallbackPieceShards } from "../src/search/pieceShards.js";
import { collectShardCandidates } from "../src/search/shardQuery.js";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { memoryBucket } from "./store/fixtures.mjs";

const TOKENIZER_2 = { tokenizer: 2, chunk: null };
const CHUNKED = { tokenizer: 1, chunk: { target: 1000, max: 1500, cap: 64_000 } };
const CHUNKED_2 = { tokenizer: 2, chunk: { target: 1000, max: 1500, cap: 64_000 } };
const NOW = Date.parse("2026-01-01T00:00:00Z");

function bucketWith(notes, format) {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2025-12-01T00:00:00Z");
    return listed;
  };
  for (const [path, text] of Object.entries(notes)) bucket.objects.set(path, { body: text, etag: `seed-${path}` });
  if (format) bucket.searchIndexFormat = format;
  return bucket;
}

async function build(bucket, options = {}) {
  for (let pass = 0; pass < 40; pass += 1) {
    const result = await syncShardedIndex(bucket, { budget: createSearchBudget(10_000), now: NOW, ...options });
    if (result.pending === 0 && !result.listingTruncated) return;
  }
  throw new Error("index did not converge");
}

function search(bucket, query, { isVisible = () => true, limit } = {}) {
  return searchIndexedNotes(bucket, {
    isVisible,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    limit,
    budget: createSearchBudget(600),
  });
}

async function indexed(notes, format) {
  const bucket = bucketWith(notes, format);
  await build(bucket);
  return bucket;
}

/** Every term the served index stored. */
async function storedTerms(bucket) {
  const terms = new Set();
  for (const shard of await storedShards(bucket)) for (const term of shard.terms.keys()) terms.add(term);
  return terms;
}

/** Every shard of the served index, parsed. */
async function storedShards(bucket) {
  const budget = createSearchBudget(1000);
  const manifest = await loadIndexManifest(bucket, budget, 0);
  const shards = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const shard = await loadShard(bucket, budget, 0, id, undefined, manifest);
    if (shard) shards.push(shard);
  }
  return shards;
}

const keys = (answer) => answer.hits.map((hit) => hit.key);

// tokenizer 2 on both sides

const TASK_30 = {
  "notes/zh.md": "数据库迁移计划已经确认，下周开始执行。",
  "notes/ja.md": "来週のリリース計画を確認してください。",
  "notes/th.md": "ฉันชอบกินข้าวมาก",
  "notes/accents.md": "Rendezvous at the Café on Tuesday.",
  "notes/code.md": "Call `fetchUserProfile(userId)` before rendering.",
  "notes/other.md": "Nothing in here is relevant to anything.",
};
const TASK_30_QUERIES = [
  ["迁移", "notes/zh.md"],
  ["リリース", "notes/ja.md"],
  ["ข้าว", "notes/th.md"],
  ["cafe", "notes/accents.md"],
  ["user profile", "notes/code.md"],
  ["fetchUserProfile", "notes/code.md"],
];

test("tokenizer 2: each Task 30 case is found by the query that names it", async () => {
  const bucket = await indexed(TASK_30, TOKENIZER_2);
  const stored = await storedTerms(bucket);
  for (const [query, path] of TASK_30_QUERIES) {
    const answer = await search(bucket, query);
    assert.equal(answer.indexed, true);
    assert.deepEqual(keys(answer), [path], `query ${query}`);
    // Identical between indexer and query: every query term is a term the
    // indexer stored for that text.
    for (const term of parseQuery(query, 2).terms) assert.ok(stored.has(term), `${query}: ${term} stored`);
  }
});

test("tokenizer 1: the same queries give today's answers", async () => {
  const bucket = await indexed(TASK_30);
  const today = [];
  for (const [query] of TASK_30_QUERIES) today.push(keys(await search(bucket, query)));
  // Today's v1 tokenizer keeps a CJK run whole and does not fold accents or
  // split identifiers, so these miss or fall back to fuzzy matching.
  assert.deepEqual(today, [[], [], [], [], ["notes/code.md"], ["notes/code.md"]]);
});

test("a tokenizer 2 query never emits the CJK two-character pieces", () => {
  const text = "数据库迁移计划已经确认，下周开始执行。";
  const { terms } = parseQuery(text, 2);
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text.normalize("NFKC"))]
    .filter((s) => s.isWordLike && s.segment.length >= 2)
    .map((s) => s.segment);
  assert.deepEqual(terms, [...new Set(words)]);
  for (const piece of ["据库", "库迁", "移计", "划已", "经确"]) assert.ok(!terms.includes(piece), piece);
  // The index side keeps them.
  assert.ok(termsOf(text, 2).includes("库迁"));
  // Phrases too.
  assert.deepEqual(parseQuery(`"${text}"`, 2).phrases, [[...new Set(words)]]);
  // Tokenizer 1 is untouched.
  assert.deepEqual(parseQuery(text, 1).terms, termsOf(text, 1));
});

// CJK fallback (OPEN-48)

const FALLBACK = {
  // Segments as 南京 / 市场; its pieces include 南京 and 京市.
  "notes/market.md": "在南京市场买菜",
  // Holds 南京 but not 京市: one piece is not enough.
  "notes/weather.md": "南京的天气很好",
};

test("a CJK word the index never stored falls back to its pieces, required together", async () => {
  // 南京市 is one segmenter word with no index entry of its own.
  assert.deepEqual(parseQuery("南京市", 2).terms, ["南京市"]);
  const bucket = await indexed(FALLBACK, TOKENIZER_2);
  assert.ok(!(await storedTerms(bucket)).has("南京市"));
  const answer = await search(bucket, "南京市");
  assert.deepEqual(keys(answer), ["notes/market.md"]);
  assert.equal(answer.matchCount, 1);
  assert.ok(answer.hits[0].snippets.length > 0, "the snippet quotes the line the pieces matched");
});

test("the fallback is tokenizer 2 only", async () => {
  const bucket = await indexed(FALLBACK);
  assert.deepEqual(keys(await search(bucket, "南京市")), []);
});

// chunk-aware ranking (OPEN-61)

function sections(count, line) {
  return Array.from({ length: count }, (_, i) => `## Section ${i}\n\n${line(i)}\n\n${"padding words ".repeat(20)}\n`).join("\n");
}

test("a note whose chunks match five or three times is one hit and counted once", async () => {
  for (const matching of [5, 3]) {
    const note = sections(5, (i) => (i < matching ? `zebrafinch sighting number ${i}` : `nothing at ${i}`));
    const bucket = await indexed({ "notes/birds.md": note, "notes/other.md": "# Other\n\nunrelated" }, CHUNKED);
    const docs = (await storedShards(bucket)).flatMap((shard) => [...shard.docs.entries()]);
    const chunks = docs.filter(([key]) => key.startsWith("notes/birds.md#c"));
    assert.equal(chunks.length, 5, "five chunks indexed");
    assert.deepEqual(chunks.map(([, doc]) => doc.chunk).sort(), [0, 1, 2, 3, 4], "each chunk doc carries its index");
    const answer = await search(bucket, "zebrafinch");
    assert.deepEqual(keys(answer), ["notes/birds.md"], `${matching} matching chunks`);
    assert.equal(answer.matchCount, 1);
  }
});

test("the kept chunk carries every matched term, so snippets quote any matching chunk", async () => {
  const note = sections(3, (i) => ["alpha lives here", "beta lives here", "nothing"][i]);
  const bucket = await indexed({ "notes/greek.md": note }, CHUNKED);
  const answer = await search(bucket, "alpha beta");
  assert.deepEqual(keys(answer), ["notes/greek.md"]);
  assert.deepEqual(answer.hits[0].snippets, ["alpha lives here", "beta lives here"]);
});

test("two chunked notes are two hits, ordered by their best chunk", async () => {
  const strong = sections(4, (i) => (i === 2 ? "quokka quokka quokka quokka" : `quokka once ${i}`));
  const weak = sections(4, (i) => (i === 0 ? "a quokka appears" : `plain ${i}`));
  const bucket = await indexed({ "notes/a-weak.md": weak, "notes/b-strong.md": strong }, CHUNKED);
  const answer = await search(bucket, "quokka");
  assert.deepEqual(keys(answer), ["notes/b-strong.md", "notes/a-weak.md"]);
  assert.equal(answer.matchCount, 2);
});

test("a channel-day note's two matching messages are still two hits", async () => {
  const msg = (i) => ({
    channel: "email",
    account: "name-at-example-com",
    messageId: `<m${i}@mail.example.net>`,
    threadId: `thread-${i}`,
    sentAt: new Date(Date.UTC(2026, 8, 7, 9, i)).toISOString(),
    subject: `Subject ${i}`,
    from: { name: "Fake Sender", address: "sender@example.net" },
    to: [{ address: "name@example.com" }],
    body: `the wombat report part ${i}`,
    attachments: [],
  });
  const day = renderChannelDayNote({
    channel: "email",
    account: "name-at-example-com",
    address: "name@example.com",
    date: "2026-09-07",
    nonce: "0123456789abcdef",
    now: "2026-09-07T18:04:11.221Z",
    events: [msg(0), msg(1)],
  });
  const path = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const bucket = await indexed({ [path]: day }, CHUNKED);
  const answer = await search(bucket, "wombat");
  assert.equal(answer.hits.length, 2);
  assert.equal(answer.matchCount, 2);
  for (const key of keys(answer)) assert.ok(key.startsWith(`${path}#msg-`), key);
});

test("a hidden note's chunks never appear and never change the visible answer", async () => {
  const visibleNotes = {
    "notes/open.md": sections(3, (i) => `platypus seen ${i}`),
    "notes/also.md": sections(2, (i) => (i ? "platypus nest" : "plain")),
  };
  const hidden = { "secret/hidden.md": sections(4, () => "platypus platypus platypus") };
  const isVisible = (path) => !path.startsWith("secret/");
  const without = await search(await indexed(visibleNotes, CHUNKED), "platypus", { isVisible });
  const withHidden = await search(await indexed({ ...visibleNotes, ...hidden }, CHUNKED), "platypus", { isVisible });
  assert.deepEqual(keys(withHidden).sort(), ["notes/also.md", "notes/open.md"]);
  for (const key of keys(withHidden)) assert.ok(!key.startsWith("secret/"));
  assert.deepEqual(withHidden.hits, without.hits);
  assert.equal(withHidden.matchCount, without.matchCount);
  assert.equal(withHidden.matchCountIsFloor, without.matchCountIsFloor);
});

test("more than fifty notes matching in several chunks: the count is a floor of notes", async () => {
  const notes = {};
  for (let i = 0; i < 60; i += 1) notes[`notes/n${String(i).padStart(2, "0")}.md`] = sections(2, (k) => `ibis count ${i} ${k}`);
  const bucket = await indexed(notes, CHUNKED);
  const answer = await search(bucket, "ibis", { limit: 60 });
  assert.equal(new Set(keys(answer)).size, answer.hits.length, "no note twice");
  assert.equal(answer.matchCount, 50);
  assert.equal(answer.matchCountIsFloor, true);
});

test("tokenizer 2 with chunks: a chunk hit's key is the note path", async () => {
  const note = sections(3, (i) => `fetchUserProfile step ${i}`);
  const bucket = await indexed({ "notes/api.md": note }, CHUNKED_2);
  const answer = await search(bucket, "user profile");
  assert.deepEqual(keys(answer), ["notes/api.md"]);
  assert.ok(!answer.hits[0].key.includes("#c"));
});

// Piece routing (fix round 1): pieces are routed and read only for a term the
// first read found nowhere.

/** Many notes spread over several shards, each holding 南京 but not 京市. */
function manyShards(extra) {
  const notes = { ...extra };
  for (let i = 0; i < 80; i += 1) {
    notes[`notes/w${String(i).padStart(2, "0")}.md`] = `南京的天气很好 ${i}\n\n${"filler words for size ".repeat(30)}`;
  }
  return notes;
}

async function shardedIndex(notes) {
  const bucket = bucketWith(notes, TOKENIZER_2);
  await build(bucket, { shardByteCap: 30_000 });
  const reads = [];
  const get = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    if (key.startsWith(".context/search/v3/shards/")) reads.push(key);
    return get(key);
  };
  return { bucket, reads };
}

test("a CJK word that hits directly reads only the shards its word routes to", async () => {
  // 南京市 is a stored word here, so its pieces 南京 and 京市 must not route.
  const { bucket, reads } = await shardedIndex(manyShards({ "notes/city.md": "南京市很大" }));
  const manifest = await loadIndexManifest(bucket, createSearchBudget(100), 0);
  assert.ok(manifest.shardCount > 2, `several shards, got ${manifest.shardCount}`);
  const claimed = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    if ((manifest.stats[id]?.docCount || 0) === 0) continue;
    const filter = readTermFilter(manifest.filters[id]);
    if (!filter || termFilterMayHold(filter, "南京市")) claimed.push(id);
  }
  assert.ok(claimed.length < manifest.stats.filter((s) => s.docCount > 0).length, "the word does not claim every shard");
  reads.length = 0;
  const answer = await search(bucket, "南京市");
  assert.deepEqual(keys(answer), ["notes/city.md"]);
  assert.equal(reads.length, claimed.length, "reads equal the word's own routing");
});

test("a CJK word found nowhere still finds its note through pieces across shards", async () => {
  const { bucket } = await shardedIndex(manyShards({ "notes/market.md": "在南京市场买菜" }));
  const answer = await search(bucket, "南京市");
  assert.deepEqual(keys(answer), ["notes/market.md"]);
  assert.equal(answer.matchCount, 1);
});

test("the fallback rung reads only the shards claiming every piece and counts nothing twice", async () => {
  const { bucket, reads } = await shardedIndex(manyShards({ "notes/market.md": "在南京市场买菜" }));
  const budget = createSearchBudget(600);
  const manifest = await loadIndexManifest(bucket, budget, 0);
  const occupied = [];
  for (let id = 0; id < manifest.shardCount; id += 1) if ((manifest.stats[id]?.docCount || 0) > 0) occupied.push(id);
  const queryTerms = ["南京市"];
  // The first read, simulated over every occupied shard: what the walk holds
  // before the rung runs.
  const collections = [];
  const held = new Map(); // piece -> docs holding it, over every shard
  for (const id of occupied) {
    const shard = await loadShard(bucket, budget, 0, id, undefined, manifest);
    collections.push({ ...collectShardCandidates(shard, queryTerms, () => true), id });
    for (const piece of ["南京", "京市"]) held.set(piece, (held.get(piece) || 0) + (shard.terms.get(piece)?.size || 0));
  }
  const claimed = occupied.filter((id) => {
    const filter = readTermFilter(manifest.filters[id]);
    return !filter || (termFilterMayHold(filter, "南京") && termFilterMayHold(filter, "京市"));
  });
  assert.ok(claimed.length < occupied.length, "the pieces do not claim every shard");
  const before = collections.reduce((n, c) => n + c.visibleN, 0);
  reads.length = 0;
  const result = await readFallbackPieceShards(bucket, budget, 10, manifest, {
    queryTerms,
    occupied,
    collections,
    isVisible: () => true,
    shardsRead: occupied.length,
  });
  assert.deepEqual(result, { shardsUnread: false, shardsRead: occupied.length + claimed.length });
  assert.equal(reads.length, claimed.length, "only shards whose filter may hold every piece are read");
  assert.equal(collections.reduce((n, c) => n + c.visibleN, 0), before, "N is not counted twice");
  // 京市 is only in the market note; 南京 is counted once per doc in the claimed shards.
  const df = (term) => collections.reduce((n, c) => n + (c.dfByTerm.get(term) || 0), 0);
  assert.equal(df("京市"), held.get("京市"));
  assert.ok(df("南京") <= held.get("南京"));
});
