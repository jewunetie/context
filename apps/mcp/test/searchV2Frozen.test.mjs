/**
 * SWITCH-OFF PIN: the v2 search index path, frozen to a digest.
 *
 * With the index format switch off, every store operation the sync and the
 * search make (operation, key, options, and each stored body) and every
 * answer must stay exactly what the code before Task 31 produced. The digest
 * below was computed by running this same scenario against the pre-Task-31
 * tree (commit edadc94f), so any later change to the default path, however
 * small, fails here and has to be argued for.
 *
 * Wall-clock fields are the only thing ignored: `generatedAt` in stored
 * objects (the pass clock is injected through `now`, and listing upload times
 * are fixed). If this fails on purpose, recompute the digest from the code
 * before the change, not after it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   v2 shard written with a trailing space in its body                       1
 *   v2 manifest written create-only instead of unconditionally when absent   1
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { generateCorpus } from "../bench/fixtures.js";
import { memoryBucket } from "./store/fixtures.mjs";

const FROZEN_DIGEST = "b4c7a5768dd2017fce5428556dafe706f84922905d365442dae9393ff17ab385";
const NOW = Date.parse("2026-01-01T00:00:00Z");
const UPLOADED = new Date("2025-12-01T00:00:00Z");

function normalize(body) {
  // Raw bytes, with only the wall-clock stamp masked, so a whitespace or key
  // order change is caught too.
  return typeof body === "string" ? body.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":null') : body;
}

/** A memory bucket that records every operation, with fixed upload times. */
function recordingBucket(log) {
  const bucket = memoryBucket();
  const { get, put, list } = bucket;
  return {
    objects: bucket.objects,
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
  const { notes, queries } = generateCorpus({ size: 100 });
  for (const note of notes) bucket.objects.set(note.path, { body: note.text, etag: `seed-${note.path}` });
  const pass = (options = {}) => syncShardedIndex(bucket, { budget: createSearchBudget(600), now: NOW, ...options });
  const results = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await pass();
    results.push([result.pending, result.listingTruncated, result.changed, result.committed]);
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  // An edit, a removal and a targeted write-path update.
  bucket.objects.set(notes[1].path, { body: `${notes[1].text}\nedited`, etag: "edit-1" });
  bucket.objects.delete(notes[2].path);
  results.push((await pass()).pending);
  bucket.objects.set(notes[3].path, { body: `${notes[3].text}\nwritten`, etag: "edit-3" });
  const only = new Map([[notes[3].path, { version: "edit-3", uploaded: UPLOADED.toISOString(), size: 10 }]]);
  results.push((await pass({ only })).pending);
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

test("switch off: the v2 store operations, bodies and answers match the pre-Task-31 digest", async () => {
  const digest = await scenario();
  assert.equal(await scenario(), digest, "the scenario is deterministic");
  assert.equal(digest, FROZEN_DIGEST);
});
