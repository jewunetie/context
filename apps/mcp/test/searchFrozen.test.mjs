/**
 * FROZEN PIN for the index: a build makes exactly the store operations, stored
 * bodies and answers recorded in the digest below. The scenario uses the
 * link-heavy fixture, so a change that let the graph or links reach a document
 * unexpectedly fails here. Only `generatedAt` is masked. If it fails on
 * purpose (a format change), bump INDEX_FORMAT_VERSION and recompute the
 * digest from the code before the change, not after it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { generateLinks } from "./fixtures/searchCorpus.js";
import { memoryBucket } from "./store/fixtures.mjs";

const INDEX_DIGEST = "fec7113aabd2c37b731dabd131f8da20a2b3ecb51a167c1bfeb86fa992e4b8fb";
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
  assert.equal(results.at(-1)[0], 0, "the build is complete, so the answers below come from a full index");
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

test("a build's store operations, bodies and answers match the frozen digest", async () => {
  // Revision keys hash each shard body, `generatedAt` included, so the clock is frozen.
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const digest = await scenario();
  assert.equal(await scenario(), digest, "the scenario is deterministic");
  mock.timers.reset();
  assert.equal(digest, INDEX_DIGEST);
});
