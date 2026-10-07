/**
 * SEARCH INDEX FORMAT v3: the format object, the v3 namespace and the dual
 * read (`src/search/format.js`, `src/search/shards/io.js`, CONTRACT-v3.md).
 *
 * Nothing here may change what default search reads: with the default format
 * every reader touches `v2/` keys only, and a v3 manifest is served only when
 * it parses as version 4, names the configured format and has completed a
 * full pass (`built: true`). Every other case serves v2 exactly as today.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   v3 read even when the configured format is the default                    1
 *   v3 served without comparing its `format` to the configured one            1
 *   v3 served without the `built` check                                       1
 *   v3 manifest that fails to parse returns null instead of falling to v2     2
 *   `parseManifestV4` accepts a newer manifest version (5)                    1
 *   `parseManifestV4` accepts an unknown `format.tokenizer`                   2
 *   `parseManifestV4` skips the `shards` length check                         1
 *   null v3 shard key fetched from the store instead of read as empty         1
 *   formatUsable without the segmenter self-test (Task 35)                    3
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FORMAT,
  formatUsable,
  formatsEqual,
  indexFormatFor,
} from "../src/search/format.js";
import {
  DOCMAP_KEY,
  MANIFEST_KEY,
  V3_DOCMAP_KEY,
  V3_MANIFEST_KEY,
  V3_SHARD_PREFIX,
  V2_LAYOUT,
  V3_LAYOUT,
  emptyManifest,
  fetchShardBytes,
  decodeShard,
  loadDocmapPaths,
  loadIndexManifest,
  parseManifest,
  parseManifestV4,
  serializeDocmap,
  serializeManifest,
  serializeManifestV4,
  shardKey,
} from "../src/search/shards.js";
import { loadCensus } from "../src/search/d1/backfill.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { isPlumbing } from "../src/privacy/engine.js";
import { writerFor } from "../src/search/shards/revisions.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { memoryBucket } from "./store/fixtures.mjs";

const TOKENIZER_2 = { tokenizer: 2, chunk: null };
const CHUNKED_2000 = { tokenizer: 1, chunk: { target: 2000, max: 3000, cap: 64_000 } };

function manifestWithDocs(shardCount, paths) {
  const manifest = emptyManifest(shardCount);
  manifest.stats[0].docCount = paths.length;
  for (const path of paths) manifest.docsByShard[0].set(path, `etag-${path}`);
  return manifest;
}

function v4Text({ shardCount = 2, format = TOKENIZER_2, built = true, shards, paths = ["a.md"] } = {}) {
  const manifest = manifestWithDocs(shardCount, paths);
  manifest.format = format;
  manifest.built = built;
  manifest.shards =
    shards ?? Array.from({ length: shardCount }, (_, id) => (id === 0 ? { key: `${V3_SHARD_PREFIX}s0-r1.json`, digest: "d0" } : null));
  return serializeManifestV4(manifest);
}

/** A bucket holding a v2 index (`v2.md`) and, optionally, a v3 one (`v3.md`). */
function bucketWith({ v3 = null, format } = {}) {
  const bucket = memoryBucket();
  const v2 = manifestWithDocs(1, ["v2.md"]);
  bucket.objects.set(MANIFEST_KEY, { body: serializeManifest(v2), etag: "m-v2" });
  bucket.objects.set(DOCMAP_KEY, { body: serializeDocmap(v2), etag: "d-v2" });
  if (v3 !== null) {
    bucket.objects.set(V3_MANIFEST_KEY, { body: v3, etag: "m-v3" });
    const docs = manifestWithDocs(2, ["v3.md"]);
    bucket.objects.set(V3_DOCMAP_KEY, { body: serializeDocmap(docs), etag: "d-v3" });
  }
  const read = [];
  const store = {
    searchIndexFormat: format,
    async get(key) {
      read.push(key);
      return bucket.get(key);
    },
  };
  return { store, read };
}

// -- the format object ------------------------------------------------------

test("indexFormatFor: absent, valid and invalid values, never a throw", () => {
  assert.deepEqual(indexFormatFor(undefined), DEFAULT_FORMAT);
  assert.deepEqual(indexFormatFor({}), DEFAULT_FORMAT);
  assert.deepEqual(indexFormatFor({ SEARCH_TOKENIZER: "2" }), TOKENIZER_2);
  assert.deepEqual(indexFormatFor({ SEARCH_TOKENIZER: "abc" }), DEFAULT_FORMAT);
  assert.deepEqual(indexFormatFor({ SEARCH_CHUNK_CHARS: "2000" }), CHUNKED_2000);
  assert.deepEqual(indexFormatFor({ SEARCH_CHUNK_CHARS: "3000" }), DEFAULT_FORMAT);
  assert.deepEqual(indexFormatFor({ SEARCH_CHUNK_CHARS: "0" }), DEFAULT_FORMAT);
  assert.deepEqual(indexFormatFor({ SEARCH_CHUNK_CHARS: "1000" }).chunk, { target: 1000, max: 1500, cap: 64_000 });
  assert.deepEqual(indexFormatFor({ SEARCH_CHUNK_CHARS: "4000" }).chunk, { target: 4000, max: 6000, cap: 64_000 });
  assert.deepEqual(indexFormatFor({ SEARCH_TOKENIZER: "2", SEARCH_CHUNK_CHARS: "abc" }), TOKENIZER_2);
});

test("formatUsable: default and in-range formats only", () => {
  assert.equal(formatUsable(DEFAULT_FORMAT), true);
  assert.equal(formatUsable(TOKENIZER_2), true);
  assert.equal(formatUsable(CHUNKED_2000), true);
  assert.equal(formatUsable({ tokenizer: 3, chunk: null }), false);
  assert.equal(formatUsable({ tokenizer: 1, chunk: { target: 3000, max: 4500, cap: 64_000 } }), false);
  assert.equal(formatUsable({ tokenizer: 1, chunk: { target: 2000, max: 9000, cap: 64_000 } }), false);
  assert.equal(formatUsable(null), false);
  assert.equal(formatsEqual(CHUNKED_2000, { tokenizer: 1, chunk: { target: 2000, max: 3000, cap: 64_000 } }), true);
  assert.equal(formatsEqual(CHUNKED_2000, TOKENIZER_2), false);
});

// -- the v4 manifest codec ----------------------------------------------------

test("v4 manifest round trip", () => {
  const parsed = parseManifestV4(v4Text());
  assert.ok(parsed);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.shardCount, 2);
  assert.deepEqual(parsed.format, TOKENIZER_2);
  assert.equal(parsed.built, true);
  assert.deepEqual(parsed.shards, [{ key: `${V3_SHARD_PREFIX}s0-r1.json`, digest: "d0" }, null]);
  assert.equal(parsed.stats[0].docCount, 1);
  // The v2 reader never parses a v4 manifest.
  assert.equal(parseManifest(v4Text()), null);
});

test("v4 manifest: malformed or newer shapes are refused", () => {
  assert.equal(parseManifestV4(v4Text({ format: { tokenizer: 9, chunk: null } })), null);
  assert.equal(parseManifestV4(v4Text({ shards: [null] })), null);
  assert.equal(parseManifestV4(v4Text({ shards: [{ key: 7, digest: "d" }, null] })), null);
  assert.equal(parseManifestV4(v4Text({ shards: [{ key: `${V3_SHARD_PREFIX}x`, digest: 1 }, null] })), null);
  // A key outside the v3 shard prefix is not a shard this layout owns.
  assert.equal(parseManifestV4(v4Text({ shards: [{ key: "notes/a.md", digest: "d" }, null] })), null);
  const newer = JSON.parse(v4Text());
  newer.version = 5;
  assert.equal(parseManifestV4(JSON.stringify(newer)), null);
  // A version-3 manifest found under v3/ is refused by the v3 reader.
  assert.equal(parseManifestV4(serializeManifest(manifestWithDocs(2, ["a.md"]))), null);
  // `built` absent reads as false; present and not boolean is refused.
  const unbuilt = JSON.parse(v4Text());
  delete unbuilt.built;
  assert.equal(parseManifestV4(JSON.stringify(unbuilt)).built, false);
  unbuilt.built = "yes";
  assert.equal(parseManifestV4(JSON.stringify(unbuilt)), null);
});

// -- the dual read -------------------------------------------------------------

test("dual read: the default format reads only v2 keys", async () => {
  for (const format of [undefined, DEFAULT_FORMAT]) {
    const { store, read } = bucketWith({ v3: v4Text({ format: TOKENIZER_2 }), format });
    const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
    assert.equal(manifest.layout, V2_LAYOUT);
    assert.deepEqual(manifest.format, DEFAULT_FORMAT);
    await loadDocmapPaths(store, createSearchBudget(10), 0);
    await loadCensus(store, createSearchBudget(10), 0);
    assert.ok(read.length > 0);
    assert.deepEqual(read.filter((key) => key.includes("/v3/")), []);
  }
});

test("dual read: tokenizer 2 configured and no v3 manifest serves v2", async () => {
  const { store } = bucketWith({ format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.equal(manifest.layout, V2_LAYOUT);
});

test("dual read: a v3 manifest not yet built serves v2", async () => {
  const { store } = bucketWith({ v3: v4Text({ built: false }), format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.equal(manifest.layout, V2_LAYOUT);
});

test("dual read: a built v3 manifest of a different format serves v2", async () => {
  const { store } = bucketWith({ v3: v4Text({ format: CHUNKED_2000 }), format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.equal(manifest.layout, V2_LAYOUT);
});

test("dual read: a malformed v3 manifest falls back to v2", async () => {
  const { store } = bucketWith({ v3: "{not json", format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.ok(manifest);
  assert.equal(manifest.layout, V2_LAYOUT);
});

test("dual read: a built matching v3 manifest is served, with its docmap", async () => {
  const { store, read } = bucketWith({ v3: v4Text(), format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  assert.equal(manifest.layout, V3_LAYOUT);
  assert.deepEqual(manifest.format, TOKENIZER_2);
  assert.deepEqual(read, [V3_MANIFEST_KEY]);

  read.length = 0;
  const docmap = await loadDocmapPaths(store, createSearchBudget(10), 0);
  assert.deepEqual(docmap.paths, ["v3.md"]);
  assert.ok(read.includes(V3_DOCMAP_KEY));
  assert.deepEqual(read.filter((key) => key.includes("/v2/")), []);

  read.length = 0;
  const census = await loadCensus(store, createSearchBudget(10), 0);
  assert.deepEqual([...census.census.keys()], ["v3.md"]);
  assert.ok(read.includes(V3_DOCMAP_KEY));
  assert.deepEqual(read.filter((key) => key.includes("/v2/")), []);
});

test("shard reads take their key from the layout; a null v3 key is an empty shard", async () => {
  const { store, read } = bucketWith({ v3: v4Text(), format: TOKENIZER_2 });
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  read.length = 0;
  await fetchShardBytes(store, createSearchBudget(10), 0, 0, undefined, manifest);
  assert.deepEqual(read, [`${V3_SHARD_PREFIX}s0-r1.json`]);

  read.length = 0;
  const empty = decodeShard(await fetchShardBytes(store, createSearchBudget(10), 0, 1, undefined, manifest));
  assert.deepEqual(read, []);
  assert.equal(empty.docs.size, 0);
  assert.equal(empty.terms.size, 0);

  read.length = 0;
  await fetchShardBytes(store, createSearchBudget(10), 0, 3);
  assert.deepEqual(read, [shardKey(3)]);
});

test("every key either layout produces is plumbing", () => {
  const manifest = parseManifestV4(v4Text());
  const keys = [
    V2_LAYOUT.manifestKey,
    V2_LAYOUT.docmapKey,
    V3_LAYOUT.manifestKey,
    V3_LAYOUT.docmapKey,
    V3_LAYOUT.shardKeyFor(0, manifest),
  ];
  for (let id = 0; id < 64; id++) keys.push(V2_LAYOUT.shardKeyFor(id));
  for (const key of keys) {
    assert.equal(isPlumbing(key), true, key);
    assert.equal(defaultIsIndexable(key), false, key);
  }
  assert.equal(V3_LAYOUT.shardKeyFor(1, manifest), null);
});

// -- the segmenter gate (Task 35) ---------------------------------------------

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

test("formatUsable: tokenizer 2 needs a passing segmenter self-test, tokenizer 1 does not", async () => {
  assert.equal(formatUsable(TOKENIZER_2), true);
  await withoutSegmenter(() => {
    assert.equal(formatUsable(TOKENIZER_2), false);
    assert.equal(formatUsable({ tokenizer: 2, chunk: CHUNKED_2000.chunk }), false);
    assert.equal(formatUsable(DEFAULT_FORMAT), true);
    assert.equal(formatUsable(CHUNKED_2000), true);
  });
  assert.equal(formatUsable(TOKENIZER_2), true);
});

test("formatUsable: a segmenter that exists but fails the self-test is refused", () => {
  const saved = Intl.Segmenter;
  // Splits identifiers and never yields 迁移.
  Intl.Segmenter = class {
    segment(s) {
      return [...s.matchAll(/[A-Z]?[a-z]+|./g)].map((m) => ({ segment: m[0], index: m.index, isWordLike: true }));
    }
  };
  try {
    assert.equal(formatUsable(TOKENIZER_2), false);
    assert.equal(formatUsable(DEFAULT_FORMAT), true);
  } finally {
    Intl.Segmenter = saved;
  }
  assert.equal(formatUsable(TOKENIZER_2), true);
});

test("segmenter gate: a tokenizer-2 store without a segmenter reads and writes only v2 keys", async () => {
  await withoutSegmenter(async () => {
    const { store, read } = bucketWith({ v3: v4Text(), format: TOKENIZER_2 });
    const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
    assert.equal(manifest.layout, V2_LAYOUT);
    await loadDocmapPaths(store, createSearchBudget(10), 0);
    await loadCensus(store, createSearchBudget(10), 0);
    assert.deepEqual(read.filter((key) => key.includes("/v3/")), []);
    assert.equal(writerFor(store).v3, false, "the pass writes v2");
  });
  // Control: with the segmenter the same store is served and written as v3.
  const { store } = bucketWith({ v3: v4Text(), format: TOKENIZER_2 });
  assert.equal((await loadIndexManifest(store, createSearchBudget(10), 0)).layout, V3_LAYOUT);
  assert.equal(writerFor(store).v3, true);
});

test("segmenter gate: a real sync pass with the self-test failing writes no v3 key", async () => {
  const run = async () => {
    const bucket = memoryBucket();
    for (let i = 0; i < 3; i += 1) await bucket.put(`notes/n${i}.md`, `# Note ${i}\n\n数据库迁移计划已经确认 item${i}\n`);
    bucket.searchIndexFormat = TOKENIZER_2;
    await syncShardedIndex(bucket, { budget: 10_000 });
    return [...bucket.objects.keys()];
  };
  const without = await withoutSegmenter(run);
  assert.ok(without.includes(MANIFEST_KEY), "v2 is built");
  assert.deepEqual(without.filter((key) => key.startsWith(".context/search/v3/")), []);
  // Control: with the segmenter the same pass writes v3 keys.
  assert.ok((await run()).some((key) => key.startsWith(".context/search/v3/")));
});
