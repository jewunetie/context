/**
 * The old-index cleanup tool (`scripts/cleanupOldSearchIndexes.mjs`): dry run
 * by default, refuses without a complete live index, removes only the orphan
 * prefixes and the one legacy file. In-memory store only; nothing here
 * reaches a real bucket.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupOldSearchIndexes, LEGACY_KEY } from "../scripts/cleanupOldSearchIndexes.mjs";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { memoryBucket } from "./store/fixtures.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const MANIFEST = ".context/search/index/manifest.json";

const ORPHANS = {
  ".context/search/v2/manifest.json": "{}",
  ".context/search/v2/shards/0.json": "x".repeat(100),
  ".context/search/v3/manifest.json": "{}",
  ".context/search/v3/docmap.json": "y".repeat(40),
  [LEGACY_KEY]: "z".repeat(10),
};
// Keys that look close to an orphan but are not: all must survive.
const KEEP = {
  "1-projects/plan.md": "# Plan\n\nship the index\n",
  "0-inbox/idea.md": "# Idea\n\nnotes\n",
  ".context/graph/manifest.json": "{}",
  ".context/moves/m1.json": "{}",
  ".context/search/v2": "not a prefix",
  ".context/search/v20/a.json": "{}",
  ".context/search/index/v2/a.json": "{}",
  ".context/search-v1.json.bak": "{}",
  ".context/search/v1/a.json": "{}",
};

async function workspace() {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2025-12-01T00:00:00Z");
    return listed;
  };
  for (const [key, body] of Object.entries(KEEP)) bucket.objects.set(key, { body, etag: `seed-${key}` });
  for (let pass = 0; pass < 40; pass += 1) {
    const result = await syncShardedIndex(bucket, { budget: createSearchBudget(10_000), now: NOW });
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  for (const [key, body] of Object.entries(ORPHANS)) bucket.objects.set(key, { body, etag: `seed-${key}` });
  return bucket;
}

const keysOf = (bucket) => [...bucket.objects.keys()].sort();
const withoutOrphans = (keys) => keys.filter((key) => !(key in ORPHANS));

test("dry run lists counts and bytes per prefix and deletes nothing", async () => {
  const bucket = await workspace();
  const before = keysOf(bucket);
  assert.ok(bucket.objects.has(MANIFEST));
  const result = await cleanupOldSearchIndexes(bucket);
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.report, [
    { prefix: ".context/search/v2/", count: 2, bytes: 102 },
    { prefix: ".context/search/v3/", count: 2, bytes: 42 },
    { prefix: LEGACY_KEY, count: 1, bytes: 10 },
  ]);
  assert.deepEqual(keysOf(bucket), before);
});

test("with the delete flag only the orphans go; notes, graph, moves and the live index survive", async () => {
  const bucket = await workspace();
  const before = keysOf(bucket);
  const result = await cleanupOldSearchIndexes(bucket, { apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 5);
  assert.deepEqual(keysOf(bucket), withoutOrphans(before));
  for (const key of Object.keys(KEEP)) assert.ok(bucket.objects.has(key), key);
  assert.ok(bucket.objects.has(MANIFEST));
  assert.ok([...bucket.objects.keys()].some((key) => key.startsWith(".context/search/index/shards/")));
  // A second run finds nothing and still succeeds.
  const again = await cleanupOldSearchIndexes(bucket, { apply: true });
  assert.deepEqual(again.report.map((r) => r.count), [0, 0, 0]);
});

test("through the logical-delete wrapper the orphans read as gone and everything else stays", async () => {
  const bucket = await workspace();
  const store = withLogicalDelete(bucket);
  const result = await cleanupOldSearchIndexes(store, { apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 5);
  for (const key of Object.keys(ORPHANS)) assert.equal(await store.get(key), null, key);
  for (const key of Object.keys(KEEP)) assert.notEqual(await store.get(key), null, key);
  assert.notEqual(await store.get(MANIFEST), null);
  assert.deepEqual((await cleanupOldSearchIndexes(store)).report.map((r) => r.count), [0, 0, 0]);
});

test("refuses, with a reason and no deletion, when the manifest is missing", async () => {
  const bucket = await workspace();
  bucket.objects.delete(MANIFEST);
  const before = keysOf(bucket);
  const result = await cleanupOldSearchIndexes(bucket, { apply: true });
  assert.equal(result.ok, false);
  assert.match(result.refused, /manifest/);
  assert.equal(result.deleted, 0);
  assert.deepEqual(keysOf(bucket), before);
});

test("refuses when the manifest is incomplete, from another version, or unreadable", async () => {
  const edits = {
    "a pass still pending": (m) => ({ ...m, freshness: { ...m.freshness, pending: 3 } }),
    "a truncated listing": (m) => ({ ...m, freshness: { ...m.freshness, truncated: true } }),
    "no freshness record": (m) => ({ ...m, freshness: { ...m.freshness, listedAt: null } }),
    "the previous format version": (m) => ({ ...m, version: m.version - 1 }),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const bucket = await workspace();
    const manifest = JSON.parse(bucket.objects.get(MANIFEST).body);
    bucket.objects.set(MANIFEST, { body: JSON.stringify(edit(manifest)), etag: "edited" });
    const before = keysOf(bucket);
    const result = await cleanupOldSearchIndexes(bucket, { apply: true });
    assert.equal(result.ok, false, name);
    assert.ok(result.refused.length > 10, name);
    assert.deepEqual(keysOf(bucket), before, name);
  }
  const bucket = await workspace();
  bucket.objects.set(MANIFEST, { body: "{not json", etag: "bad" });
  assert.equal((await cleanupOldSearchIndexes(bucket, { apply: true })).ok, false);
  assert.equal(bucket.objects.has(LEGACY_KEY), true);
});
