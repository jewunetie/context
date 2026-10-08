/**
 * SWITCH-OFF PIN for the v3 namespace: with SEARCH_ANCHOR_TEXT unset, a v3
 * build (tokenizer 2, 1,000-character chunks) makes exactly the store
 * operations, stored bodies and answers the tree before anchor-text indexing
 * made (commit fd50bdb6). The scenario uses the link-heavy fixture, so a
 * change that let the graph or links reach a v3 document without the switch
 * fails here. Same masking rule as searchV2Frozen.test.mjs: only
 * `generatedAt`. If it fails on purpose, recompute from the code before the
 * change, not after it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { indexFormatFor } from "../src/search/format.js";
import { generateLinks } from "../bench/fixtures.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { V3_MANIFEST_KEY } from "../src/search/shards/constants.js";

const V3_OFF_DIGEST = "9e9946f330f934d881ac1249d87ba3452544630b2f26b665a1c18b96b977bddd";
const NOW = Date.parse("2026-01-01T00:00:00Z");
const UPLOADED = new Date("2025-12-01T00:00:00Z");

const normalize = (body) =>
  typeof body === "string" ? body.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":null') : body;

function recordingBucket(log) {
  const bucket = memoryBucket();
  const { get, put, list } = bucket;
  return {
    objects: bucket.objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true },
    searchIndexFormat: indexFormatFor({ SEARCH_TOKENIZER: "2", SEARCH_CHUNK_CHARS: "1000" }),
    async get(key) {
      log.push(["get", key]);
      return get(key);
    },
    async put(key, value, options) {
      log.push(["put", key, options ?? null, normalize(value)]);
      return put(key, value, options);
    },
    async delete(key) {
      log.push(["delete", key]);
      return bucket.delete(key);
    },
    async list(options) {
      log.push(["list", options ?? null]);
      const listed = await list(options);
      for (const object of listed.objects) object.uploaded = UPLOADED;
      return listed;
    },
  };
}

async function scenario() {
  const log = [];
  const bucket = recordingBucket(log);
  const { notes, queries } = generateLinks({ size: 600 });
  for (const note of notes) bucket.objects.set(note.path, { body: note.text, etag: `seed-${note.path}` });
  const pass = (options = {}) =>
    syncShardedIndex(bucket, { budget: createSearchBudget(4000), now: NOW, visibilityOf: () => "team", ...options });
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    const result = await pass();
    results.push([result.pending, result.listingTruncated, result.changed, result.committed]);
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  assert.equal(JSON.parse(bucket.objects.get(V3_MANIFEST_KEY).body).built, true, "v3 is built, so the answers below are v3's");
  bucket.objects.set(notes[1].path, { body: `${notes[1].text}\nedited`, etag: "edit-1" });
  bucket.objects.delete(notes[2].path);
  results.push((await pass()).pending);
  const answers = [];
  for (const { query } of queries) {
    answers.push(
      await searchIndexedNotes(bucket, {
        isVisible: () => true,
        isIndexable: (key) => key.endsWith(".md"),
        query,
        budget: createSearchBudget(600),
      })
    );
  }
  return createHash("sha256").update(JSON.stringify({ log, results, answers })).digest("hex");
}

test("switch off: a v3 build's store operations, bodies and answers match the pre-anchor digest", async () => {
  // Revision keys hash each shard body, `generatedAt` included, so the clock is frozen.
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const digest = await scenario();
  assert.equal(await scenario(), digest, "the scenario is deterministic");
  mock.timers.reset();
  assert.equal(digest, V3_OFF_DIGEST);
});
