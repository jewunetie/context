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
 *   (the `layout` gate in `maintainNow` was removed in fix round 1: it was
 *   dead, `collectShardRevisions` refuses a non-v3 manifest itself)
 *
 *   Fix round 1:
 *   cursor not stored between passes (always restart)                        3
 *   cursor kept after a finished listing (no wrap to the start)              2
 *   supersession protection ignored (retained keys and `after`)             16
 *   first pass with no state protects nothing                               15
 *   cursor bounds in `readState` removed (cursor 100k long or with a newline) 1
 *   (`retained` count bound and `isKeyList(current)` removal: 0 failing, the
 *   per-entry checks reject the same inputs; the bounds only cap size)
 *
 *   Fix round 2:
 *   state size cap removed from the read (over-cap state read with text())   1
 *   whole-pass budget check removed (read and list without a state write)    1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVISION_RETENTION_MS,
  GC_BUDGET_FLOOR,
  GC_STATE_KEY,
  GC_STATE_MAX_BYTES,
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
import { withLogicalDelete } from "../src/store/logicalDelete.js";
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
  bucket.cursors = [];
  bucket.deleted = [];
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    bucket.listed.push(options?.prefix);
    bucket.cursors.push(options?.cursor);
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

/**
 * The first pass over a store has no record of what was current before it, so
 * it protects every unreferenced revision for one window and deletes nothing
 * (fix round 1). Tests that want deletions run this long before `NOW`.
 */
function prime(store, manifest) {
  return collectShardRevisions(store, createSearchBudget(100), { manifest, now: NOW - 2 * REVISION_RETENTION_MS });
}

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
  const first = await prime(bucket, manifest);
  assert.equal(first.deleted, 0, "the first pass only records what is current");
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
  const budget = createSearchBudget(GC_BUDGET_FLOOR + 5);
  bucket.deleted.length = 0;
  const report = await collectShardRevisions(bucket, budget, { manifest, now: NOW });
  // The state read, one listing, two deletes and the state write spend five,
  // which leaves exactly the floor.
  assert.equal(report.deleted, 2);
  assert.equal(budget.spent, 5);
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

// -- fix round 1: progress through the listing, retention from supersession --------

/** A bucket that pages by cursor like a provider, so the real wrapper can sit on it. */
function pagedBucket() {
  const objects = new Map();
  let counter = 0;
  const raw = {
    objects,
    uploadedAt: new Map(),
    capabilities: { conditionalWrite: true, conditionalCreate: true },
    async get(key) {
      if (!objects.has(key)) return null;
      const o = objects.get(key);
      return { etag: o.etag, size: o.body.length, contentType: o.contentType, text: async () => o.body, arrayBuffer: async () => new TextEncoder().encode(o.body).buffer };
    },
    async head(key) {
      if (!objects.has(key)) return null;
      const o = objects.get(key);
      return { etag: o.etag, size: o.body.length, contentType: o.contentType };
    },
    async put(key, value, options = {}) {
      const expected = options.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options.onlyIf?.absent && objects.has(key)) return null;
      counter += 1;
      objects.set(key, { body: typeof value === "string" ? value : new TextDecoder().decode(value), etag: `m${counter}`, contentType: options.contentType });
      return { etag: `m${counter}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      if (cursor !== undefined && !(typeof cursor === "string" && (cursor === "" || objects.has(cursor) || cursor.startsWith(prefix)))) {
        throw new Error("invalid continuation token");
      }
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().filter((key) => !cursor || key > cursor);
      const page = keys.slice(0, limit);
      return {
        objects: page.map((key) => ({ key, size: objects.get(key).body.length, uploaded: raw.uploadedAt.get(key) ?? OLD })),
        truncated: keys.length > limit,
        cursor: keys.length > limit ? page.at(-1) : undefined,
      };
    },
  };
  return raw;
}

const hex = (i) => i.toString(16).padStart(16, "0");
const revision = (i) => `${V3_SHARD_PREFIX}000-${hex(i)}.json`;
const liveBodies = (raw) => [...raw.objects.entries()].filter(([key, o]) => key.startsWith(V3_SHARD_PREFIX) && o.body === "x".repeat(300)).length;

function pagedFixture({ stale, young = 0 }) {
  const raw = pagedBucket();
  const store = withLogicalDelete(raw);
  // Young keys sort first (low hex), so they sit at the front of every listing.
  for (let i = 1; i <= young; i += 1) {
    raw.objects.set(revision(i), { body: "x".repeat(300), etag: `y${i}` });
    raw.uploadedAt.set(revision(i), YOUNG);
  }
  for (let i = 1; i <= stale; i += 1) raw.objects.set(revision(1000 + i), { body: "x".repeat(300), etag: `e${i}` });
  const live = revision(5000);
  raw.objects.set(live, { body: "x".repeat(300), etag: "live" });
  const manifest = { layout: V3_LAYOUT, shards: [{ key: live, digest: "d" }] };
  return { raw, store, manifest, live };
}

async function passes(store, manifest, count, now = NOW) {
  const reports = [];
  for (let pass = 0; pass < count; pass += 1) {
    reports.push(await collectShardRevisions(store, createSearchBudget(2000), { manifest, now }));
  }
  return reports;
}

test("real logical-delete store: 260 stale revisions are all collected across passes", async () => {
  const { raw, store, manifest, live } = pagedFixture({ stale: 260 });
  await prime(store, manifest);
  // Tombstones stay in the provider listing, so a pass without a stored cursor
  // would re-list the same first 200 keys forever.
  await passes(store, manifest, 6);
  assert.equal(liveBodies(raw), 1, "only the referenced revision still has a body");
  assert.ok(raw.objects.has(live));
});

test("real logical-delete store: kept keys at the front do not stop collection behind them", async () => {
  const { raw, store, manifest } = pagedFixture({ stale: 100, young: 250 });
  await prime(store, manifest);
  await passes(store, manifest, 8);
  assert.equal(liveBodies(raw), 250 + 1, "the 250 young and the referenced revision remain, nothing else");
});

test("the cursor is stored between passes and cleared when the listing ends", async () => {
  const { raw, store, manifest } = pagedFixture({ stale: 260 });
  const state = () => JSON.parse(raw.objects.get(GC_STATE_KEY).body);
  await prime(store, manifest);
  assert.equal(typeof state().cursor, "string", "a truncated listing leaves a cursor");
  await collectShardRevisions(store, createSearchBudget(2000), { manifest, now: NOW });
  assert.equal(state().cursor, undefined, "the end of the listing wraps to the start");
});

test("a stored state that is garbage is ignored and replaced, and deletes nothing that pass", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  for (const garbage of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ version: 1, cursor: 12345, retained: "x", current: {} }),
    JSON.stringify({ version: 99, cursor: "c" }),
    JSON.stringify({ version: 1, cursor: "a".repeat(100_000), retained: Array.from({ length: 5000 }, () => ({ keys: [1], at: "no" })) }),
    // Valid except for a cursor too long to hand to a provider.
    JSON.stringify({ version: 1, observedAt: 1, current: [], retained: [], cursor: "a".repeat(100_000) }),
    JSON.stringify({ version: 1, observedAt: 1, current: [], retained: [], cursor: "line\nbreak" }),
  ]) {
    bucket.cursors.length = 0;
    await bucket.put(GC_STATE_KEY, garbage);
    const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
    assert.equal(report.deleted, 0, garbage.slice(0, 30));
    assert.deepEqual(bucket.cursors, [undefined], "a cursor outside the bounds is never handed to the store");
    for (const key of stale) assert.ok(bucket.objects.has(key));
    const rewritten = JSON.parse(bucket.objects.get(GC_STATE_KEY).body);
    assert.equal(rewritten.version, 1);
    assert.ok(JSON.stringify(rewritten).length < 20_000);
  }
});

test("a stored cursor the provider refuses restarts from the front", async () => {
  const { raw, store, manifest } = pagedFixture({ stale: 10 });
  await prime(store, manifest);
  const state = JSON.parse(raw.objects.get(GC_STATE_KEY).body);
  state.cursor = "!!bogus!!";
  raw.objects.set(GC_STATE_KEY, { body: JSON.stringify(state), etag: "s" });
  await passes(store, manifest, 1);
  assert.equal(liveBodies(raw), 1);
});

test("the first pass, with no record of what was current, deletes nothing", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  bucket.objects.delete(GC_STATE_KEY);
  const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
  assert.equal(report.deleted, 0);
  for (const key of stale) assert.ok(bucket.objects.has(key), "protected for one window from the first observation");
  const later = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW + REVISION_RETENTION_MS + 1000 });
  assert.equal(later.deleted, stale.length);
});

test("a revision superseded seconds ago is kept however old its upload; collected after the window", async () => {
  const bucket = bucketWithClock();
  await seed(bucket);
  await syncUntilBuilt(bucket);
  const before = manifestOf(bucket);
  await prime(bucket, before);
  // A reader pins `before` now. An edit supersedes it seconds later; the old
  // revisions were uploaded long ago (OLD), so upload age alone would free them.
  await bucket.put("notes/n0.md", "# Note 0\n\nrewritten words about delta\n");
  await syncUntilBuilt(bucket);
  const after = manifestOf(bucket);
  const superseded = referencedKeys(before).filter((key) => !referencedKeys(after).includes(key));
  assert.ok(superseded.length >= 1);

  const seen = await collectShardRevisions(bucket, createSearchBudget(100), { manifest: after, now: NOW });
  assert.equal(seen.deleted, 0);
  const seconds = await collectShardRevisions(bucket, createSearchBudget(100), { manifest: after, now: NOW + 30_000 });
  assert.equal(seconds.deleted, 0);
  for (const key of superseded) assert.ok(bucket.objects.has(key), `${key} still readable by the pinned reader`);

  const done = await collectShardRevisions(bucket, createSearchBudget(100), { manifest: after, now: NOW + REVISION_RETENTION_MS + 1000 });
  assert.equal(done.deleted, superseded.length);
  for (const key of superseded) assert.ok(!bucket.objects.has(key));
});

// -- fix round 2: a size cap on the state read, the whole pass fits or nothing runs --

test("a stored state over the size cap is never read with text() and counts as no state", async () => {
  const { bucket, manifest, stale } = await withSupersededRevision();
  // A valid state with a cursor, so reading it would change what is listed.
  const state = JSON.parse(bucket.objects.get(GC_STATE_KEY).body);
  await bucket.put(GC_STATE_KEY, JSON.stringify({ ...state, cursor: `${V3_SHARD_PREFIX}zzz` }));
  const get = bucket.get.bind(bucket);
  for (const [size, read] of [
    [GC_STATE_MAX_BYTES + 1, false],
    [GC_STATE_MAX_BYTES, true],
  ]) {
    let texts = 0;
    bucket.get = async (key) => {
      const object = await get(key);
      if (key !== GC_STATE_KEY || !object) return object;
      return { ...object, size, text: async () => ((texts += 1), object.text()) };
    };
    bucket.cursors.length = 0;
    const report = await collectShardRevisions(bucket, createSearchBudget(100), { manifest, now: NOW });
    assert.equal(texts, read ? 1 : 0, `size ${size}`);
    assert.deepEqual(bucket.cursors, [read ? `${V3_SHARD_PREFIX}zzz` : undefined], `size ${size}`);
    if (!read) {
      assert.equal(report.deleted, 0, "no state protects everything for one window");
      for (const key of stale) assert.ok(bucket.objects.has(key));
    }
    bucket.get = get;
    await bucket.put(GC_STATE_KEY, JSON.stringify({ ...state, cursor: `${V3_SHARD_PREFIX}zzz` }));
  }
});

test("a budget that cannot cover read, list and state write touches the store not at all", async () => {
  const { bucket, manifest } = await withSupersededRevision();
  const ops = [];
  for (const name of ["get", "head", "exists", "list", "put", "delete"].filter((name) => bucket[name])) {
    const original = bucket[name].bind(bucket);
    bucket[name] = async (...args) => (ops.push(name), original(...args));
  }
  const before = bucket.objects.get(GC_STATE_KEY).body;
  const short = createSearchBudget(GC_BUDGET_FLOOR + 2);
  await collectShardRevisions(bucket, short, { manifest, now: NOW + 1000 });
  assert.deepEqual(ops, [], "no read and no list when the state write would not fit");
  assert.equal(short.spent, 0);

  const enough = createSearchBudget(GC_BUDGET_FLOOR + 3);
  await collectShardRevisions(bucket, enough, { manifest, now: NOW + 1000 });
  assert.deepEqual(ops, ["get", "list", "put"]);
  assert.notEqual(bucket.objects.get(GC_STATE_KEY).body, before, "the pass persists its state");
  assert.equal(JSON.parse(bucket.objects.get(GC_STATE_KEY).body).observedAt, NOW + 1000);
});
