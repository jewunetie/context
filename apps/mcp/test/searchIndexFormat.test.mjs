/**
 * SEARCH INDEX FORMAT: the constants, the manifest codec, the single index
 * namespace and the not-ready states (`src/search/format.js`,
 * `src/search/shards/io.js`, CONTRACT.md "Revisioned shards").
 *
 * There is one index and one format. A manifest is served when it parses as
 * `INDEX_FORMAT_VERSION`; any other version (the previous index format was 5)
 * is read as absent and the index is rebuilt from the notes.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file, measured on the file as committed.
 *
 *   `parseManifest` accepts a manifest of the previous version (4)            3
 *   `parseManifest` accepts a newer manifest version                          1
 *   `parseManifest` skips the `shards` length check                           1
 *   `parseManifest` accepts a key outside the shard prefix                    1
 *   null shard key fetched from the store instead of read as empty            1
 *   `loadIndexManifest` skips the segmenter self-test                         1
 *   `syncShardedIndex` skips the segmenter self-test                          1
 *   a stored manifest of another version is not replaced (conditional put
 *   on its etag removed; needs a store with create-only writes)               1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHUNK, INDEX_FORMAT_VERSION } from "../src/search/format.js";
import {
  DOCMAP_KEY,
  MANIFEST_KEY,
  SHARD_PREFIX,
  emptyManifest,
  fetchShardBytes,
  decodeShard,
  loadDocmapPaths,
  loadIndexManifest,
  parseManifest,
  serializeDocmap,
  serializeManifest,
  syncShardedIndex,
} from "../src/search/shards.js";
import { loadCensus } from "../src/search/d1/backfill.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { isPlumbing } from "../src/privacy/engine.js";
import { memoryBucket } from "./store/fixtures.mjs";

const SHARD_KEY = `${SHARD_PREFIX}000-0123456789abcdef.json`;

function manifestWithDocs(shardCount, paths) {
  const manifest = emptyManifest(shardCount);
  manifest.stats[0].docCount = paths.length;
  for (const path of paths) manifest.docsByShard[0].set(path, `etag-${path}`);
  return manifest;
}

function manifestText({ shardCount = 2, shards, paths = ["a.md"] } = {}) {
  const manifest = manifestWithDocs(shardCount, paths);
  manifest.shards =
    shards ?? Array.from({ length: shardCount }, (_, id) => (id === 0 ? { key: SHARD_KEY, digest: "d0" } : null));
  return serializeManifest(manifest);
}

/** A bucket holding an index (`indexed.md`), read through a store that records the keys it is asked for. */
function bucketWithIndex({ text = manifestText() } = {}) {
  const bucket = memoryBucket();
  bucket.objects.set(MANIFEST_KEY, { body: text, etag: "m1" });
  bucket.objects.set(DOCMAP_KEY, { body: serializeDocmap(manifestWithDocs(2, ["indexed.md"])), etag: "d1" });
  const read = [];
  const store = {
    async get(key) {
      read.push(key);
      return bucket.get(key);
    },
  };
  return { bucket, store, read };
}

// The constants

test("the format constants: version 6 and 1,000-character chunks capped at 64,000", () => {
  assert.equal(INDEX_FORMAT_VERSION, 6);
  assert.deepEqual({ ...CHUNK }, { target: 1000, max: 1500, cap: 64_000 });
  assert.equal(MANIFEST_KEY, ".context/search/index/manifest.json");
  assert.equal(DOCMAP_KEY, ".context/search/index/docmap.json");
  assert.equal(SHARD_PREFIX, ".context/search/index/shards/");
});

// The manifest codec

test("manifest round trip", () => {
  const parsed = parseManifest(manifestText());
  assert.ok(parsed);
  assert.equal(parsed.version, INDEX_FORMAT_VERSION);
  assert.equal(parsed.shardCount, 2);
  assert.deepEqual(parsed.shards, [{ key: SHARD_KEY, digest: "d0" }, null]);
  assert.equal(parsed.stats[0].docCount, 1);
  assert.equal("format" in parsed, false, "the version is the format check, there is no format field");
  assert.equal("built" in parsed, false, "a manifest is served from the first commit, there is no built flag");
});

test("manifest: another version, malformed or foreign shapes are refused", () => {
  const valid = JSON.parse(manifestText());
  // The previous index format was 4; a stored manifest of it is stale and rebuilt.
  assert.equal(parseManifest(JSON.stringify({ ...valid, version: 4, format: { tokenizer: 2, chunk: null }, built: true })), null);
  assert.equal(parseManifest(JSON.stringify({ ...valid, version: INDEX_FORMAT_VERSION + 1 })), null);
  assert.equal(parseManifest(JSON.stringify({ ...valid, version: INDEX_FORMAT_VERSION - 1 })), null, "the previous version rebuilds");
  assert.equal(parseManifest(JSON.stringify({ ...valid, version: 3 })), null);
  assert.equal(parseManifest(JSON.stringify({ ...valid, shards: [valid.shards[0]] })), null, "one entry for two shards");
  assert.equal(parseManifest(manifestText({ shards: [{ key: 7, digest: "d" }, null] })), null);
  assert.equal(parseManifest(manifestText({ shards: [{ key: `${SHARD_PREFIX}x`, digest: 1 }, null] })), null);
  // A key outside the shard prefix is not a shard this layout owns.
  assert.equal(parseManifest(manifestText({ shards: [{ key: "notes/a.md", digest: "d" }, null] })), null);
  assert.equal(parseManifest(manifestText({ shards: [{ key: ".context/search/v3/shards/000-x.json", digest: "d" }, null] })), null);
  // A null key over a shard whose stats count documents would hide them.
  assert.equal(parseManifest(manifestText({ shards: [null, null] })), null);
});

// The reads

test("the manifest is read from the index namespace only, and is served from its first commit", async () => {
  const { store, read } = bucketWithIndex();
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.ok(manifest);
  assert.deepEqual(read, [MANIFEST_KEY]);

  read.length = 0;
  const docmap = await loadDocmapPaths(store, createSearchBudget(10), 0);
  assert.deepEqual(docmap.paths, ["indexed.md"]);
  assert.ok(read.includes(DOCMAP_KEY));

  read.length = 0;
  const census = await loadCensus(store, createSearchBudget(10), 0);
  assert.deepEqual([...census.census.keys()], ["indexed.md"]);
  assert.ok(read.includes(DOCMAP_KEY));
  assert.deepEqual(read.filter((key) => key.includes("/v2/") || key.includes("/v3/")), []);
});

test("not ready: no manifest, an older-version manifest or a corrupt one all read as no index", async () => {
  const none = bucketWithIndex();
  none.bucket.objects.delete(MANIFEST_KEY);
  assert.equal(await loadIndexManifest(none.store, createSearchBudget(10), 0), null);

  const older = bucketWithIndex({ text: JSON.stringify({ ...JSON.parse(manifestText()), version: 4, built: true }) });
  assert.equal(await loadIndexManifest(older.store, createSearchBudget(10), 0), null);

  const corrupt = bucketWithIndex({ text: "{not json" });
  assert.equal(await loadIndexManifest(corrupt.store, createSearchBudget(10), 0), null);
});

test("shard reads take their key from the manifest; a null key or no manifest is an empty shard", async () => {
  const { store, read } = bucketWithIndex();
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  read.length = 0;
  await fetchShardBytes(store, createSearchBudget(10), 0, 0, undefined, manifest);
  assert.deepEqual(read, [SHARD_KEY]);

  read.length = 0;
  const empty = decodeShard(await fetchShardBytes(store, createSearchBudget(10), 0, 1, undefined, manifest));
  assert.deepEqual(read, []);
  assert.equal(empty.docs.size, 0);
  assert.equal(empty.terms.size, 0);

  read.length = 0;
  const unnamed = decodeShard(await fetchShardBytes(store, createSearchBudget(10), 0, 3));
  assert.deepEqual(read, []);
  assert.equal(unnamed.docs.size, 0);
});

test("every key the index produces is plumbing", () => {
  for (const key of [MANIFEST_KEY, DOCMAP_KEY, SHARD_KEY]) {
    assert.equal(isPlumbing(key), true, key);
    assert.equal(defaultIsIndexable(key), false, key);
  }
});

// A stale manifest is replaced

test("a stored manifest of another version is replaced by the next pass, not stalled behind", async () => {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (let i = 0; i < 3; i += 1) await bucket.put(`notes/n${i}.md`, `# Note ${i}\n\nitem${i} words here\n`);
  // What the previous index format left at this key: version 4 with a format and a built flag.
  const stale = JSON.stringify({ ...JSON.parse(manifestText()), version: 4, format: { tokenizer: 2, chunk: null }, built: true });
  await bucket.put(MANIFEST_KEY, stale);
  assert.equal(parseManifest(stale), null);

  for (let pass = 0; pass < 6; pass += 1) {
    const result = await syncShardedIndex(bucket, { budget: createSearchBudget(10_000) });
    if (result.pending === 0) break;
  }
  const fresh = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
  assert.ok(fresh, "the stale object was overwritten with a manifest of this version");
  assert.equal(fresh.stats.reduce((sum, entry) => sum + entry.docCount, 0) >= 3, true);
  assert.notEqual(bucket.objects.get(MANIFEST_KEY).body, stale);
});

// The segmenter gate (Task 35)

/** Run `fn` with `Intl.Segmenter` removed, restoring it whatever happens. */
async function withoutSegmenter(fn) {
  const saved = Intl.Segmenter;
  delete Intl.Segmenter;
  try {
    return await fn();
  } finally {
    Intl.Segmenter = saved;
  }
}

test("segmenter gate: without a working segmenter nothing is served and nothing is written", async () => {
  const { store } = bucketWithIndex();
  assert.ok(await loadIndexManifest(store, createSearchBudget(10), 0), "control: served with a segmenter");
  await withoutSegmenter(async () => {
    assert.equal(await loadIndexManifest(store, createSearchBudget(10), 0), null);
  });
});

test("segmenter gate: a sync pass with the self-test failing writes no index key", async () => {
  const run = async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 3; i += 1) await bucket.put(`notes/n${i}.md`, `# Note ${i}\n\n数据库迁移计划已经确认 item${i}\n`);
    await syncShardedIndex(bucket, { budget: 10_000 });
    return [...bucket.objects.keys()].filter((key) => key.startsWith(".context/search/"));
  };
  assert.deepEqual(await withoutSegmenter(run), []);
  // Control: with the segmenter the same pass writes the index.
  assert.ok((await run()).includes(MANIFEST_KEY));
});
