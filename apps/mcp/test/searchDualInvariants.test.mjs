/**
 * The dual v2/v3 pass never costs the served index its progress (Task 31
 * stall fix, simple form: v2 always goes first, no alternation).
 *
 * v2 is what readers see while v3 builds, and v3 is an opt-in experiment. So
 * with v3 building, the served index must settle within twice the passes v2
 * took before the dual pass existed (aaa15ab5), here with one unreadable note.
 * Served is v2 until v3 is built, then v3. With one unreadable note v3 is
 * never built (its `built` needs pending 0), so these cells measure v2.
 *
 * Base passes to settle (aaa15ab5, this fixture, one unreadable note):
 *   40 notes:   budget 13: 20, 14: 14, 15: 10, 16: 8 (11: never, in 4000)
 *   1000 notes: budget 13: 706, 14: 396, 15: 279, 16: 217 (11: never, in 4000)
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   a v3 pass runs before the v2 pass                    every test here
 *   the v3 pass is handed no listing                     the listing reuse test
 *                                                        (and the 3 liveness cells)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { syncShardedIndex } from "../src/search/shards.js";
import { DEFERRED_SYNC_FLOOR } from "../src/search/pacing.js";
import { MANIFEST_KEY, V3_MANIFEST_KEY, V3_DOCMAP_KEY } from "../src/search/shards/constants.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const TOKENIZER_2 = { tokenizer: 2, chunk: null };
const UNREADABLE = "f0/n0.md";

async function seeded(notes, folders = 1, { unreadable = false } = {}) {
  const bucket = r2LikeBucket();
  for (let i = 0; i < notes; i += 1) await bucket.put(`f${i % folders}/n${i}.md`, `# Note ${i}\n\nalpha beta secretword${i}\n`);
  if (unreadable) {
    const { get } = bucket;
    bucket.get = async (key, ...rest) => {
      if (key === UNREADABLE) throw new Error("unreadable");
      return get(key, ...rest);
    };
  }
  bucket.searchIndexFormat = TOKENIZER_2;
  return bucket;
}

const stored = (bucket, key) => {
  const object = bucket.objects.get(key);
  return object ? JSON.parse(object.body) : null;
};
const indexed = (manifest) => (manifest ? manifest.stats.reduce((sum, entry) => sum + (entry?.docCount || 0), 0) : 0);

/** Silences the pass log lines; returns the search-index-format ones. */
async function quietly(run) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.includes("search-index-format")).map((line) => JSON.parse(line));
}

/**
 * Passes until the served index (v2, or v3 once it is built and readers switch
 * to it) holds every readable note with a complete listing; -1 if not within
 * `bound`.
 */
async function passesToSettleV2(bucket, notes, budget, bound) {
  let settled = -1;
  await quietly(async () => {
    for (let pass = 0; pass < bound && settled < 0; pass += 1) {
      await syncShardedIndex(bucket, { budget });
      const v3 = stored(bucket, V3_MANIFEST_KEY);
      const manifest = v3?.built === true ? v3 : stored(bucket, MANIFEST_KEY);
      if (indexed(manifest) === notes - 1 && manifest.freshness?.truncated === false) settled = pass;
    }
  });
  return settled;
}

// [notes, budget, bound]: each bound is twice the base passes above.
for (const [notes, budget, bound] of [
  [40, 13, 40], [40, DEFERRED_SYNC_FLOOR, 28], [40, 15, 20], [40, 16, 16],
  [1000, 13, 1412], [1000, DEFERRED_SYNC_FLOOR, 792], [1000, 15, 558], [1000, 16, 434],
]) {
  test(`v2 settles while v3 builds: ${notes} notes, one unreadable, budget ${budget}, within ${bound} passes`, async () => {
    const bucket = await seeded(notes, 1, { unreadable: true });
    assert.notEqual(await passesToSettleV2(bucket, notes, budget, bound), -1);
  });
}

test("the served v2 index never loses progress to v3: v2 always goes first", async () => {
  // Same bucket with the switch off and on: after every pass the v2 manifest
  // holds the same notes, because the v3 build only gets what v2 left over.
  // The one op the switch costs v2 is the v3-served check (one read of the v3
  // manifest, before v2 runs), so the off bucket runs at budget - 1.
  for (const [notes, folders, budget] of [[40, 1, DEFERRED_SYNC_FLOOR], [1000, 1, DEFERRED_SYNC_FLOOR], [200, 14, 40]]) {
    const off = await seeded(notes, folders);
    delete off.searchIndexFormat;
    const on = await seeded(notes, folders);
    const fixedNow = Date.parse("2026-01-01T00:00:00Z");
    await quietly(async () => {
      for (let pass = 0; pass < 40; pass += 1) {
        await syncShardedIndex(off, { budget: budget - 1, now: fixedNow });
        await syncShardedIndex(on, { budget, now: fixedNow });
        assert.equal(indexed(stored(on, MANIFEST_KEY)), indexed(stored(off, MANIFEST_KEY)), `${notes} notes, budget ${budget}, pass ${pass}`);
      }
    });
  }
});

test("a throwing v3 pass leaves the v2 pass's progress in place, and the error still surfaces", async () => {
  const bucket = await seeded(40);
  // A capped backfill, so v3 is still building (not served).
  await quietly(() => syncShardedIndex(bucket, { budget: 1000, backfillOps: 5 }));
  assert.equal(stored(bucket, V3_MANIFEST_KEY)?.built, false);
  await bucket.put("f0/late.md", "# Late\n\nwombat\n");
  const { get } = bucket;
  bucket.get = async (key, ...rest) => {
    if (key === V3_DOCMAP_KEY) throw new Error("v3 storage failure");
    return get(key, ...rest);
  };
  await quietly(() => assert.rejects(syncShardedIndex(bucket, { budget: 1000 }), /v3 storage failure/));
  assert.equal(indexed(stored(bucket, MANIFEST_KEY)), 41, "the v2 pass ran first and indexed the new note");
});

test("listing reuse: an interactive dual pass walks the bucket once", async () => {
  // Interactive (capped backfill) passes leave the v3 pass budget to spare,
  // which it would otherwise spend walking the bucket again to fetch nothing:
  // one root listing plus one per top-level folder, 15 subrequests here.
  const bucket = await seeded(200, 14);
  const { list } = bucket;
  let lists = 0;
  bucket.list = async (options) => {
    lists += 1;
    return list(options);
  };
  await quietly(async () => {
    for (let pass = 0; pass < 4; pass += 1) {
      lists = 0;
      await syncShardedIndex(bucket, { budget: 600, backfillOps: 20 });
      assert.equal(lists, 15, `pass ${pass}`);
    }
  });
});
