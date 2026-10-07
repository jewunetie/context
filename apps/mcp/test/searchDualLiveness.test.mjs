/**
 * The dual v2/v3 pass makes progress on v3 at a fixed budget (Task 31 stall).
 *
 * While v3 builds, a pass runs the v2 pass and then gives v3 the leftover. If
 * the v3 pass pays again for the listing v2 just took, low budgets leave it
 * nothing for a single note fetch and v3 is never served. Each cell runs passes
 * at one fixed budget against an R2-like bucket (stable etags) and requires v3
 * to be served: v2 converging is not enough.
 *
 * Also the v3 log line (N1): a v3 pass that did not list must not log
 * `pending: 0`, which reads as done.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   syncDual hands the v3 pass no listing (listing: null)    the 3 liveness cells fail
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { syncShardedIndex, loadIndexManifest } from "../src/search/shards.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { DEFERRED_SYNC_FLOOR } from "../src/search/pacing.js";
import { MANIFEST_WRITE_RESERVE, FETCH_FLOOR } from "../src/search/shards/constants.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const TOKENIZER_2 = { tokenizer: 2, chunk: null };

async function seeded(notes, folders) {
  const bucket = r2LikeBucket();
  for (let i = 0; i < notes; i += 1) await bucket.put(`f${i % folders}/n${i}.md`, `# N${i}\n\n数据库迁移 word${i}\n`);
  return bucket;
}

/** Runs `run` and returns the parsed search-index-format lines it logged. */
async function formatLines(run) {
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

for (const [notes, folders, budget] of [[40, 1, DEFERRED_SYNC_FLOOR], [40, 1, 15], [200, 14, 40]]) {
  test(`v3 is served: ${notes} notes, ${folders} folder(s), budget ${budget}`, async () => {
    const bucket = await seeded(notes, folders);
    bucket.searchIndexFormat = TOKENIZER_2;
    let served = "v2";
    await formatLines(async () => {
      for (let pass = 0; pass < 1000 && served !== "v3"; pass += 1) {
        await syncShardedIndex(bucket, { budget });
        served = (await loadIndexManifest(bucket, createSearchBudget(10), 0)).layout.namespace;
      }
    });
    assert.equal(served, "v3");
  });
}

test("N1: a v3 pass that listed logs its pending count and truncated false", async () => {
  const bucket = await seeded(3, 1);
  bucket.searchIndexFormat = TOKENIZER_2;
  const [line] = await formatLines(() => syncShardedIndex(bucket, { budget: 1000 }));
  assert.equal(line.pending, 0);
  assert.equal(line.truncated, false);
  assert.equal(line.built, true);
});

test("N1: a v3 pass refused at the reserve logs pending null and truncated true", async () => {
  const bucket = await seeded(3, 1);
  bucket.searchIndexFormat = TOKENIZER_2;
  const lines = await formatLines(() => syncShardedIndex(bucket, { budget: 5, reserve: 5 }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].pending, null);
  assert.equal(lines[0].truncated, true);
  assert.equal(lines[0].built, false);
});

test("N1: a targeted pass with no v3 manifest logs pending null and truncated true", async () => {
  const bucket = await seeded(3, 1);
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await syncShardedIndex(bucket, { budget: 1000 })).pending === 0) break;
  }
  bucket.searchIndexFormat = TOKENIZER_2;
  const { etag } = await bucket.put("f0/new.md", "# New\n\nquokka\n");
  const only = new Map([["f0/new.md", { version: etag, size: 14 }]]);
  const [line] = await formatLines(() => syncShardedIndex(bucket, { budget: 1000, only }));
  assert.equal(line.pending, null);
  assert.equal(line.truncated, true);
});

test("N1: a v3 pass whose listing was refused logs pending null and truncated true", async () => {
  const bucket = await seeded(3, 1);
  bucket.searchIndexFormat = TOKENIZER_2;
  // The v3-served check and the v2 manifest read leave exactly the listing's
  // own floor, so the root listing is refused; the v3 pass reads its manifest
  // with the last ops and has no listing of its own.
  const budget = 2 + MANIFEST_WRITE_RESERVE + FETCH_FLOOR;
  const [line] = await formatLines(() => syncShardedIndex(bucket, { budget }));
  assert.equal(line.pending, null);
  assert.equal(line.truncated, true);
});
