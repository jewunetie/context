/**
 * SEARCH INDEX v3 GARBAGE COLLECTION: unreferenced shard revisions
 * (`src/search/shards/gc.js`, CONTRACT-v3.md "Collecting revisions", ruling
 * OPEN-59).
 *
 * A pass that loses the manifest commit, and every superseded shard, leaves a
 * content-addressed revision nothing references. `collectShardRevisions` lists
 * one page of `.context/search/v3/shards/` and deletes a revision only when the
 * current manifest does not name it and its `uploaded` is older than the
 * retention window, the time an in-flight reader that pinned the previous
 * manifest needs to finish. It never lists or deletes outside that prefix.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   referenced-revision check removed from the delete condition             5
 *   list prefix widened to `.context/search/`                                2
 *   key shape and prefix check removed (a listing that over-returns)         2
 *   retention window ignored (age check removed)                             2
 *   `uploaded` ignored (every revision treated as old)                       2
 *   unknown `uploaded` (epoch 0, missing) treated as old                     1
 *   create-only refusal recorded as present without `exists` (tombstone)     1
 *   v3 layout check removed from `collectShardRevisions`                     1
 *   budget floor ignored (`take(0)`)                                         1
 *   GC failure not caught in `maintainNow`                                   1
 *   `layout`/`built` gate in `maintainNow` removed: 0 failing, by design;
 *     `collectShardRevisions` refuses a non-v3 manifest itself, and v3 is only
 *     the pass's manifest once it is built (the dual-mode pass returns the v2
 *     manifest while v3 builds), so the gate only saves the call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVISION_RETENTION_MS,
  GC_BUDGET_FLOOR,
  collectShardRevisions,
} from "../src/search/shards/gc.js";
import { writerFor } from "../src/search/shards/revisions.js";
import {
  MANIFEST_KEY,
  V3_MANIFEST_KEY,
  V3_LAYOUT,
  V3_SHARD_PREFIX,
  parseManifestV4,
  syncShardedIndex,
} from "../src/search/shards.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { memoryBucket } from "./store/fixtures.mjs";

const FORMAT = { tokenizer: 1, chunk: null, namespace: "v3" };
const NOW = Date.parse("2026-06-01T12:00:00Z");
const OLD = new Date(NOW - 10 * REVISION_RETENTION_MS);
const YOUNG = new Date(NOW - Math.floor(REVISION_RETENTION_MS / 3));

/** A bucket whose listings report `uploaded` from `bucket.uploadedAt` (default: old). */
function bucketWithClock() {
  const bucket = memoryBucket();
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  bucket.searchIndexFormat = FORMAT;
  bucket.uploadedAt = new Map();
  bucket.listed = [];
  bucket.deleted = [];
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    bucket.listed.push(options?.prefix);
    const page = await list(options);
    for (const object of page.objects) {
      const at = bucket.uploadedAt.has(object.key) ? bucket.uploadedAt.get(object.key) : OLD;
      if (at === "missing") delete object.uploaded;
      else object.uploaded = at;
    }
    return page;
  };
  const del = bucket.delete.bind(bucket);
  bucket.delete = async (key, options) => {
    bucket.deleted.push(key);
    return del(key, options);
  };
  return bucket;
}

async function seed(bucket, count = 6) {
  for (let i = 0; i < count; i += 1) {
    await bucket.put(`notes/n${i}.md`, `# Note ${i}\n\nalpha beta item${i} gamma\n`);
  }
}

async function syncUntilBuilt(store) {
  for (let pass = 0; pass < 10; pass += 1) {
    const result = await syncShardedIndex(store, { budget: 1000, now: NOW });
    if (result.pending === 0 && !result.listingTruncated) return result;
  }
  throw new Error("did not converge");
}

const manifestOf = (bucket) => ({ ...parseManifestV4(bucket.objects.get(V3_MANIFEST_KEY).body), layout: V3_LAYOUT });
const revisionKeys = (bucket) => [...bucket.objects.keys()].filter((key) => key.startsWith(V3_SHARD_PREFIX));
const referencedKeys = (manifest) => manifest.shards.filter(Boolean).map((entry) => entry.key);

/** Build v3, then edit a note and sync again: one superseded, unreferenced revision. */
async function withSupersededRevision() {
  const bucket = bucketWithClock();
  await seed(bucket);
  await syncUntilBuilt(bucket);
  const before = referencedKeys(manifestOf(bucket));
  await bucket.put("notes/n0.md", "# Note 0\n\nrewritten words about delta\n");
  await syncUntilBuilt(bucket);
  const manifest = manifestOf(bucket);
  const stale = before.filter((key) => !referencedKeys(manifest).includes(key));
  assert.ok(stale.length >= 1, "an edit leaves a superseded revision behind");
  return { bucket, manifest, stale };
}

test("a referenced revision is never deleted, however old", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW + 365 * 86_400_000 });
  for (const key of referencedKeys(manifest)) assert.ok(bucket.objects.has(key), `${key} survives`);
  assert.ok(report.deleted >= 1);
  assert.deepEqual(bucket.deleted.filter((key) => referencedKeys(manifest).includes(key)), []);
});

test("an unreferenced revision older than the window is deleted, a younger one survives", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  bucket.uploadedAt.set(stale[0], YOUNG);
  const young = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  assert.equal(young.deleted, 0);
  assert.ok(bucket.objects.has(stale[0]), "within the retention window it survives");

  bucket.uploadedAt.set(stale[0], new Date(NOW - REVISION_RETENTION_MS - 1000));
  const old = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  assert.equal(old.deleted, stale.length);
  for (const key of stale) assert.ok(!bucket.objects.has(key), `${key} is collected`);
});

test("a listing with no usable uploaded time deletes nothing", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  for (const unknown of ["missing", new Date(0), new Date("not a date"), new Date(NOW + 60_000)]) {
    for (const key of stale) bucket.uploadedAt.set(key, unknown);
    const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
    assert.equal(report.deleted, 0, String(unknown));
    for (const key of stale) assert.ok(bucket.objects.has(key));
  }
});

test("only .context/search/v3/shards/ is listed or deleted", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  const bystanders = [
    ".context/search/v2/shards/000.json",
    ".context/search/v2/manifest.json.old",
    ".context/search/v3/docmap.json.old",
    ".context/graph/v1/manifest.json",
    ".context/graph/v1/g/1/nodes/abc.json",
    "notes/keep.md",
    `${V3_SHARD_PREFIX.slice(0, -1)}-sibling/000-0123456789abcdef.json`,
  ];
  for (const key of bystanders) await bucket.put(key, "x");
  bucket.listed.length = 0;
  bucket.deleted.length = 0;
  await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  assert.ok(bucket.listed.length >= 1);
  for (const prefix of bucket.listed) assert.equal(prefix, V3_SHARD_PREFIX);
  assert.deepEqual(bucket.deleted.sort(), [...stale].sort());
  for (const key of bystanders) assert.ok(bucket.objects.has(key), `${key} untouched`);
});

test("a listing that over-returns keys outside the prefix still deletes nothing outside it", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  const outside = [".context/search/v2/shards/001.json", ".context/graph/v1/manifest.json", "notes/n1.md"];
  const inside = `${V3_SHARD_PREFIX}099-0123456789abcdef.json`;
  await bucket.put(inside, "x");
  for (const key of outside) await bucket.put(key, "x");
  const list = bucket.list;
  bucket.list = async (options) => {
    const page = await list(options);
    const extra = outside.map((key) => ({ key, size: 1, uploaded: OLD }));
    return { ...page, objects: [...page.objects, ...extra] };
  };
  bucket.deleted.length = 0;
  await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  for (const key of outside) assert.ok(bucket.objects.has(key), `${key} untouched`);
  assert.ok(!bucket.deleted.some((key) => outside.includes(key)));
  assert.ok(!bucket.objects.has(inside), "a stray revision-shaped key inside the prefix is collected");
});

test("a key under the prefix that is not a revision name is kept", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  const odd = [`${V3_SHARD_PREFIX}notes.md`, `${V3_SHARD_PREFIX}sub/000-0123456789abcdef.json`, `${V3_SHARD_PREFIX}000-XYZ.json`];
  for (const key of odd) await bucket.put(key, "x");
  await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  for (const key of odd) assert.ok(bucket.objects.has(key), `${key} kept`);
});

test("a manifest that is absent, v2 or without v3 layout deletes nothing and lists nothing", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  for (const bad of [undefined, null, { shards: [] }, { ...manifest, layout: "v2" }, { ...manifest, shards: undefined }]) {
    bucket.listed.length = 0;
    const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest: bad, now: NOW });
    assert.equal(report.deleted, 0);
    assert.deepEqual(bucket.listed, []);
  }
});

test("the budget bounds the pass: one listing, then deletes, never below the floor", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  for (let i = 0; i < 5; i += 1) await bucket.put(`${V3_SHARD_PREFIX}1${i}0-0123456789abcdef.json`, "x");
  const total = stale.length + 5;
  const budget = createSearchBudget(GC_BUDGET_FLOOR + 3);
  bucket.deleted.length = 0;
  const report = await collectShardRevisions(bucket, budget, { manifest, now: NOW });
  // One listing and two deletes spend three, which leaves exactly the floor.
  assert.equal(report.deleted, 2);
  assert.equal(budget.spent, 3);
  assert.equal(budget.remaining, GC_BUDGET_FLOOR);
  assert.equal(bucket.deleted.length, 2);
  assert.ok(total > 2);

  const starved = createSearchBudget(GC_BUDGET_FLOOR);
  const none = await collectShardRevisions(bucket, starved, { manifest, now: NOW });
  assert.equal(none.deleted, 0);
  assert.equal(starved.spent, 0);
});

test("a delete that throws is counted, does not stop the pass and does not escape", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  await bucket.put(`${V3_SHARD_PREFIX}098-0123456789abcdef.json`, "x");
  const del = bucket.delete;
  let first = true;
  bucket.delete = async (key, options) => {
    if (first) {
      first = false;
      throw new Error("boom");
    }
    return del(key, options);
  };
  const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  assert.equal(report.failed, 1);
  assert.ok(report.deleted >= 1);
});

// -- maintenance wiring -----------------------------------------------------------

const isIndexable = (key) => key.endsWith(".md");

async function maintain(bucket, remaining = 200) {
  return maintainIndexAfter(bucket, createSearchBudget(remaining), isIndexable, null, undefined);
}

test("maintenance collects superseded revisions after the sync while v3 is served", async () => {
  const { bucket, stale } = await withSupersededRevision();
  await bucket.put("notes/n1.md", "# Note 1\n\nanother rewrite entirely\n");
  assert.equal(await maintain(bucket), "inline");
  for (const key of stale) assert.ok(!bucket.objects.has(key), `${key} collected`);
  const manifest = manifestOf(bucket);
  for (const key of referencedKeys(manifest)) assert.ok(bucket.objects.has(key), `${key} still referenced and present`);
});

test("maintenance with the switch off never touches the v3 prefix", async () => {
  const bucket = bucketWithClock();
  delete bucket.searchIndexFormat;
  await seed(bucket);
  await bucket.put(`${V3_SHARD_PREFIX}000-0123456789abcdef.json`, "x");
  bucket.listed.length = 0;
  await maintain(bucket);
  assert.ok(bucket.objects.has(MANIFEST_KEY));
  assert.ok(!bucket.listed.includes(V3_SHARD_PREFIX));
  assert.ok(bucket.objects.has(`${V3_SHARD_PREFIX}000-0123456789abcdef.json`));
});

test("maintenance does not collect while v3 is still being built", async () => {
  const bucket = bucketWithClock();
  await seed(bucket);
  await bucket.put(`${V3_SHARD_PREFIX}000-0123456789abcdef.json`, "x");
  // One tiny budget: the pass cannot finish the v3 build, so v2 is still served.
  await maintain(bucket, 4);
  assert.ok(bucket.objects.has(`${V3_SHARD_PREFIX}000-0123456789abcdef.json`));
});

test("maintenance below the budget floor does not collect", async () => {
  const { bucket, stale } = await withSupersededRevision();
  bucket.listed.length = 0;
  await maintain(bucket, 6);
  for (const key of stale) assert.ok(bucket.objects.has(key), "superseded revision kept when the budget is thin");
  assert.ok(!bucket.listed.includes(V3_SHARD_PREFIX) || bucket.deleted.length === 0);
});

test("a garbage-collection failure does not change the maintenance result", async () => {
  const baseline = await withSupersededRevision();
  await baseline.bucket.put("notes/n1.md", "# Note 1\n\nanother rewrite entirely\n");
  const expected = await maintain(baseline.bucket);
  const expectedManifest = manifestOf(baseline.bucket);

  const failing = await withSupersededRevision();
  await failing.bucket.put("notes/n1.md", "# Note 1\n\nanother rewrite entirely\n");
  const list = failing.bucket.list;
  failing.bucket.list = async (options) => {
    if (options?.prefix === V3_SHARD_PREFIX) throw new Error("listing failed");
    return list(options);
  };
  const outcome = await maintain(failing.bucket);
  assert.equal(outcome, expected);
  // Shard bodies carry timestamps, so digests differ run to run; compare the rest.
  const published = manifestOf(failing.bucket);
  assert.equal(published.built, expectedManifest.built);
  assert.deepEqual(published.stats, expectedManifest.stats);
  assert.deepEqual(published.freshness.pending, expectedManifest.freshness.pending);
  for (const key of referencedKeys(published)) assert.ok(failing.bucket.objects.has(key));
  for (const key of failing.stale) assert.ok(failing.bucket.objects.has(key), "nothing was collected");
});

// -- putShard and logical-delete tombstones (controller amendment) ----------------

/**
 * A store where deleting a key leaves a tombstone: the key reads as absent
 * (`exists`, `get`) but a create-only put over it is refused, which is what a
 * logical-delete store that cannot recreate over a marker looks like.
 */
function tombstoningBucket() {
  const bucket = bucketWithClock();
  const tombstones = new Set();
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, value, options) => {
    if (tombstones.has(key)) return null;
    return put(key, value, options);
  };
  bucket.delete = async (key) => {
    bucket.objects.delete(key);
    tombstones.add(key);
  };
  bucket.exists = async (key) => bucket.objects.has(key);
  bucket.tombstones = tombstones;
  return bucket;
}

test("a create-only revision put refused over a tombstone is not recorded as present", async () => {
  const bucket = tombstoningBucket();
  const writer = writerFor(bucket);
  const manifest = { shards: [] };
  await writer.putShard(bucket, manifest, 0, "body one");
  const key = manifest.shards[0].key;
  assert.ok(bucket.objects.has(key));

  // Collected, then the shard reverts to the same bytes: same content address.
  await bucket.delete(key);
  const reverted = { shards: [] };
  assert.equal(await writer.putShard(bucket, reverted, 0, "body one"), false, "not persisted, so the pass does not record it");
  assert.equal(reverted.shards[0], undefined, "the manifest in memory does not name a revision that is gone");
});

test("a create-only revision put refused because the same bytes exist is recorded", async () => {
  const bucket = tombstoningBucket();
  const writer = writerFor(bucket);
  const first = { shards: [] };
  await writer.putShard(bucket, first, 0, "body one");
  const again = { shards: [] };
  await writer.putShard(bucket, again, 0, "body one");
  assert.deepEqual(again.shards[0], first.shards[0]);
});
