/**
 * THE INDEX WRITER: revisioned shards and conditional publication
 * (`src/search/shards/revisions.js`, `shards/sync.js`, CONTRACT.md
 * "Revisioned shards").
 *
 * Every touched shard is written to a new content-addressed revision key, the
 * manifest names each shard's exact key and digest, and the manifest write is
 * the single conditional commit point, so a pass that loses it leaves only
 * unreferenced revisions behind and a reader pinned to an older manifest keeps
 * reading the revisions that manifest names.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file, measured on the file as committed.
 *
 *   shard written to one fixed key per shard id                               7
 *   revision put not awaited (manifest published before its shards)           3
 *   manifest write ignores its etag (unconditional)                           2
 *   `parseManifest` accepts a null shard key whose stats hold documents       1
 *   chunking indexes whole notes instead of `chunkNote` chunks                1
 *   revision put without the create-only precondition                         2
 *
 * Not observable here: dropping the CJK two-character pieces fails nothing,
 * because the segmenter already yields every query word this file asks for
 * (a piece-only query cannot be typed: the query side drops one-character
 * words). The pieces are pinned in tokenizer.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHUNK } from "../src/search/format.js";
import {
  DOCMAP_KEY,
  MANIFEST_KEY,
  SHARD_PREFIX,
  emptyManifest,
  loadIndexManifest,
  loadShard,
  parseManifest,
  parseShard,
  serializeManifest,
  syncShardedIndex,
} from "../src/search/shards.js";
import { chunkNote } from "../src/search/chunk.js";
import { buildTermFilter } from "../src/search/filter.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { indexWrittenNotes } from "../src/search/writeProjection.js";
import { sha256Hex } from "../src/ingestion/inbox.js";
import { generateCorpus } from "./fixtures/searchCorpus.js";
import { memoryBucket } from "./store/fixtures.mjs";

/** Small enough that 60 short notes need more than one shard. */
const SMALL_CAP = 40_000;
const REVISION_KEY = /^\.context\/search\/index\/shards\/\d{3}-[0-9a-f]{16}\.json$/;

function conditionalBucket(options) {
  const bucket = memoryBucket(options);
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  // A fixed upload time, so recency never breaks a tie differently per bucket.
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2026-01-01T00:00:00Z");
    return listed;
  };
  return bucket;
}

function noteText(i, extra = "") {
  const filler = Array.from({ length: 40 }, (_, k) => `filler${(i * 7 + k) % 97}`).join(" ");
  return `# Note ${i}\n\nshared words about topic${i % 7} and item${i} ${extra}\n\n${filler}\n`;
}

async function seedNotes(bucket, count) {
  for (let i = 0; i < count; i += 1) await bucket.put(`notes/n${String(i).padStart(3, "0")}.md`, noteText(i));
}

function sync(store, options = {}) {
  return syncShardedIndex(store, { budget: 10_000, shardByteCap: SMALL_CAP, now: Date.parse("2026-01-01T00:00:00Z"), ...options });
}

async function buildUntilDone(store, options = {}) {
  for (let pass = 0; pass < 30; pass += 1) {
    const result = await sync(store, options);
    if (result.pending === 0 && !result.listingTruncated) return result;
  }
  throw new Error("index did not converge");
}

function storedManifest(bucket) {
  const stored = bucket.objects.get(MANIFEST_KEY);
  return stored ? parseManifest(stored.body) : null;
}

/** Every key the manifest names exists, parses, matches its digest and its filter. */
async function assertCoherent(bucket, manifest = storedManifest(bucket)) {
  assert.ok(manifest, "a manifest is published");
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const entry = manifest.shards[id];
    if (entry === null) {
      assert.equal(manifest.stats[id].docCount, 0, `shard ${id} has no key and no docs`);
      continue;
    }
    assert.match(entry.key, REVISION_KEY);
    const stored = bucket.objects.get(entry.key);
    assert.ok(stored, `shard ${id} revision ${entry.key} exists`);
    const shard = parseShard(stored.body);
    assert.ok(shard, `shard ${id} parses`);
    assert.equal(entry.digest, await sha256Hex(stored.body));
    assert.equal(entry.key.slice(SHARD_PREFIX.length + 4, -5), entry.digest.slice(0, 16));
    // Rebuilt from the referenced shard and compared byte for byte.
    assert.equal(manifest.filters[id], buildTermFilter(shard.terms.keys()), `shard ${id} filter`);
  }
}

function search(store, query) {
  return searchIndexedNotes(store, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
  });
}

test("revision keys are content addressed and the manifest names key and digest", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const manifest = storedManifest(bucket);
  assert.ok(manifest.shardCount >= 2, "the fixture spans several shards");
  assert.ok(bucket.objects.has(DOCMAP_KEY));
  await assertCoherent(bucket);
});

test("a manifest is published only after every revision it names is stored", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  const put = bucket.put.bind(bucket);
  let checked = 0;
  bucket.put = async (key, value, options) => {
    if (key === MANIFEST_KEY) {
      const manifest = parseManifest(value);
      for (const entry of manifest.shards) {
        if (entry) assert.ok(bucket.objects.has(entry.key), `${entry.key} stored before the manifest`);
      }
      checked += 1;
    } else if (key.startsWith(SHARD_PREFIX)) {
      // A slow shard write: a manifest that does not wait for it is caught.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return put(key, value, options);
  };
  await buildUntilDone(bucket);
  await bucket.put("notes/n001.md", noteText(1, "zebra"));
  await buildUntilDone(bucket);
  assert.ok(checked >= 2);
  await assertCoherent(bucket);
});

test("concurrent passes: the loser's revisions are unreferenced and the winner is coherent", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);

  const put = bucket.put.bind(bucket);
  const writesA = [];
  let pauseA = null;
  let releaseA = null;
  let inA = true;
  bucket.put = async (key, value, options) => {
    if (inA && key.startsWith(SHARD_PREFIX)) {
      writesA.push(key);
      if (!pauseA) {
        // A has fetched its notes and is about to store its first revision.
        pauseA = new Promise((resolve) => (releaseA = resolve));
        await pauseA;
      }
    }
    return put(key, value, options);
  };

  await bucket.put("notes/n005.md", noteText(5, "alpha"));
  const passA = sync(bucket);
  for (let wait = 0; !pauseA && wait < 2000; wait += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(pauseA, "pass A writes a revision");
  inA = false;
  await put("notes/n005.md", noteText(5, "bravo"));
  const resultB = await sync(bucket);
  const winner = storedManifest(bucket);
  inA = true;
  releaseA();
  const resultA = await passA;

  assert.equal(resultB.committed, true);
  assert.equal(resultA.committed, false, "the second manifest write loses");
  const final = storedManifest(bucket);
  assert.deepEqual(final.shards, winner.shards, "the loser changed nothing the winner published");
  const referenced = new Set(final.shards.filter(Boolean).map((entry) => entry.key));
  assert.ok(writesA.length > 0);
  for (const key of writesA) assert.equal(referenced.has(key), false, `${key} is the loser's`);
  await assertCoherent(bucket);
  const answer = await search(bucket, "bravo");
  assert.equal(answer.hits.length, 1);
});

test("a pass never writes to a key any published manifest references", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  const put = bucket.put.bind(bucket);
  const referenced = new Set();
  bucket.put = async (key, value, options) => {
    const written = await put(key, value, options);
    if (written && key.startsWith(SHARD_PREFIX)) {
      assert.equal(referenced.has(key), false, `${key} overwritten while referenced`);
    }
    if (written && key === MANIFEST_KEY) {
      for (const entry of parseManifest(value).shards) if (entry) referenced.add(entry.key);
    }
    return written;
  };
  await buildUntilDone(bucket);
  for (const word of ["one", "two", "three"]) {
    await bucket.put("notes/n002.md", noteText(2, word));
    await Promise.all([sync(bucket), sync(bucket)]);
  }
  await buildUntilDone(bucket);
  assert.ok(referenced.size > 0);
});

test("a revision already present is never overwritten", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 4);
  const put = bucket.put.bind(bucket);
  const shardPuts = [];
  bucket.put = async (key, value, options) => {
    if (key.startsWith(SHARD_PREFIX)) shardPuts.push(options);
    return put(key, value, options);
  };
  await buildUntilDone(bucket);
  assert.ok(shardPuts.length > 0);
  for (const options of shardPuts) assert.deepEqual(options, { onlyIf: { absent: true } });
});

test("readers pinned to an older manifest still read its revisions", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const pinned = await loadIndexManifest(bucket, createSearchBudget(10), 0);

  await bucket.put("notes/n003.md", noteText(3, "zanzibar"));
  await buildUntilDone(bucket);
  const current = await loadIndexManifest(bucket, createSearchBudget(10), 0);
  const changed = current.shards.findIndex((entry, id) => entry?.key !== pinned.shards[id]?.key);
  assert.ok(changed >= 0, "the edit wrote a new revision");
  const old = await loadShard(bucket, createSearchBudget(10), 0, changed, undefined, pinned);
  const fresh = await loadShard(bucket, createSearchBudget(10), 0, changed, undefined, current);
  assert.equal(old.terms.has("zanzibar"), false);
  assert.equal(fresh.terms.has("zanzibar"), true);
});

test("budget exhaustion leaves the previous manifest and its revisions readable", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const before = bucket.objects.get(MANIFEST_KEY).body;
  for (let i = 0; i < 10; i += 1) await bucket.put(`notes/n00${i}.md`, noteText(i, "later"));
  // Enough to read the manifest, the docmap and list, not to store a shard.
  await sync(bucket, { budget: 4 });
  const after = storedManifest(bucket);
  assert.ok(after);
  await assertCoherent(bucket, parseManifest(before));
  await assertCoherent(bucket, after);
});

test("a crash mid-build leaves the old manifest serving", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const before = bucket.objects.get(MANIFEST_KEY).body;

  for (let i = 0; i < 60; i += 1) await bucket.put(`notes/n${String(i).padStart(3, "0")}.md`, noteText(i, "crash"));
  const put = bucket.put.bind(bucket);
  let shardWrites = 0;
  bucket.put = async (key, value, options) => {
    if (key.startsWith(SHARD_PREFIX) && ++shardWrites === 2) throw new Error("worker killed");
    return put(key, value, options);
  };
  await assert.rejects(sync(bucket), /worker killed/);
  assert.equal(bucket.objects.get(MANIFEST_KEY).body, before);
  await assertCoherent(bucket);
  assert.ok(await loadIndexManifest(bucket, createSearchBudget(10), 0), "the old manifest is still served");
});

test("a backend that ignores preconditions: the pass completes and labels nothing new", async () => {
  const plain = conditionalBucket();
  const weak = conditionalBucket({ ignoreIfMatch: true });
  for (const bucket of [plain, weak]) {
      await seedNotes(bucket, 10);
  }
  const a = await buildUntilDone(plain);
  const b = await buildUntilDone(weak);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
  assert.equal(b.committed, true);
  assert.ok(storedManifest(weak));
  const answer = await search(weak, "item3");
  assert.equal(answer.indexIncomplete, false);
  assert.equal(answer.hits.length, 1);
});

test("a fresh manifest is a create-only write where the store supports it", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 3);
  const put = bucket.put.bind(bucket);
  const manifestPuts = [];
  bucket.put = async (key, value, options) => {
    if (key === MANIFEST_KEY) manifestPuts.push(options ?? null);
    return put(key, value, options);
  };
  await sync(bucket);
  await bucket.put("notes/n000.md", noteText(0, "again"));
  await sync(bucket);
  assert.deepEqual(manifestPuts[0], { onlyIf: { absent: true } });
  assert.ok(manifestPuts[1]?.onlyIf?.etagMatches);
});

// -- the manifest codec (controller amendment a) --------------------------------

test("parseManifestV4 refuses a null shard key over a shard that holds documents", () => {
  const manifest = emptyManifest(2);
  manifest.stats[1].docCount = 3;
  manifest.shards = [null, null];
  assert.equal(parseManifest(serializeManifest(manifest)), null);
  manifest.stats[1].docCount = 0;
  assert.ok(parseManifest(serializeManifest(manifest)));
});

// The index and the query use the one tokenizer

test("a CJK query matches through words and two-character pieces, with snippet lines from the same tokenizer", async () => {
  const bucket = conditionalBucket();
  await bucket.put("notes/a.md", "# A\n\n数据库迁移计划已经确认\n");
  await buildUntilDone(bucket);
  const answer = await search(bucket, "迁移计划");
  assert.deepEqual(answer.hits.map((hit) => hit.key), ["notes/a.md"]);
  assert.ok(answer.hits[0].snippets.length > 0, "snippet lines use the same tokenizer");
});

// Chunking (amendment b)

test("the index holds the chunks chunkNote returns", async () => {
  const bucket = conditionalBucket();
  const long = Array.from({ length: 12 }, (_, i) => `## Part ${i}\n\n${"words ".repeat(60)}section${i}\n`).join("\n");
  await bucket.put("notes/long.md", long);
  await bucket.put("notes/empty.md", "");
  await buildUntilDone(bucket);
  const docs = storedManifest(bucket).shards.filter(Boolean)
    .flatMap((entry) => [...parseShard(bucket.objects.get(entry.key).body).docs.entries()]);
  const chunks = chunkNote("notes/long.md", long, CHUNK).chunks;
  assert.ok(chunks.length > 1);
  const longDocs = docs.filter(([, doc]) => doc.notePath === "notes/long.md");
  assert.deepEqual(longDocs.map(([key]) => key).sort(), chunks.map((_, i) => `notes/long.md#c${i}`).sort());
  // An empty (or encrypted) note still records its version.
  assert.ok(docs.some(([, doc]) => doc.notePath === "notes/empty.md"));
  const again = await sync(bucket);
  assert.equal(again.pending, 0);
  assert.equal(again.changed, false);
});

// The write path

async function writeNote(bucket, path, text) {
  const { etag } = await bucket.put(path, text);
  await indexWrittenNotes(bucket, [{ path, version: etag, size: text.length }]);
}

test("a note written through the write path is found, and the manifest names its new revision", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const before = storedManifest(bucket);
  await writeNote(bucket, "notes/new.md", "# New\n\nthe quokka arrived\n");
  assert.deepEqual((await search(bucket, "quokka")).hits.map((hit) => hit.key), ["notes/new.md"]);
  const after = storedManifest(bucket);
  assert.ok(after.shards.some((entry, id) => entry?.key !== before.shards[id]?.key), "a shard has a new revision");
  await assertCoherent(bucket);
});
