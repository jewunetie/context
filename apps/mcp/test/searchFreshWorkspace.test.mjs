/**
 * A fresh workspace: before any pass there is no index (search would answer
 * from the literal scan), one pass sequence builds the single index under
 * `.context/search/index/`, and that index finds a stemmed query, a CJK query,
 * a camelCase identifier query and an alias by its anchor text.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   Porter2 stemming removed from the tokenizer                              1
 *   anchor text not read by the sync                                         1
 *
 * Not observable here, by design: dropping the CJK two-character pieces or the
 * whole-identifier form fails nothing, because the segmenter already yields
 * the word 迁移 and the identifier query splits into the same parts. Those
 * are pinned in tokenizer.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { initGraphManifest } from "../src/graph/manifest.js";
import { projectNote } from "../src/graph/project.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { loadIndexManifest, syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const NOTES = {
  "notes/jog.md": "# Jog\n\nShe was running every morning before work.\n",
  "notes/plan.md": "# Plan\n\n数据库迁移计划已经确认\n",
  "notes/code.md": "# Code\n\nCall fetchUserProfile before rendering.\n",
  "notes/a.md": "# Kickoff\n\nThe first meeting for [[b|qlcodename]] went well.\n",
  "notes/b.md": "# The plan\n\nThe plan itself, in plain words.\n",
};
const isIndexable = (key) => key.endsWith(".md");
const big = () => createSearchBudget(100000);

function search(store, query) {
  return searchIndexedNotes(store, { isVisible: () => true, isIndexable, query, budget: createSearchBudget(600) });
}

test("a fresh workspace has no index, then builds the single index and finds each kind of query", async () => {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (const [path, body] of Object.entries(NOTES)) await store.put(path, body);
  await initGraphManifest(store, big(), { mode: "conditional", now: NOW });
  for (const [path, body] of Object.entries(NOTES)) {
    const { state } = await projectNote(store, path, body, "1", { budget: big(), gen: "1", mode: "conditional", now: NOW });
    assert.equal(state, "projected", path);
  }

  // Not ready: no manifest, so the answer says it is not indexed and nothing is invented.
  assert.equal(await loadIndexManifest(store, big(), 0), null);
  assert.equal((await search(store, "running")).indexed, false);

  for (let pass = 0; pass < 20; pass += 1) {
    const result = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable, now: NOW, visibilityOf: () => "team" });
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  const keys = [...store.objects.keys()].filter((key) => key.startsWith(".context/search/"));
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !key.startsWith(".context/search/index/")), [], "one index namespace only");

  const paths = async (query) => (await search(store, query)).hits.map((hit) => hit.key).sort();
  assert.deepEqual(await paths("runs"), ["notes/jog.md"], "a stemmed query: runs finds running");
  assert.deepEqual(await paths("迁移"), ["notes/plan.md"], "a CJK word inside a run");
  assert.deepEqual(await paths("user profile"), ["notes/code.md"], "the words of a camelCase identifier");
  assert.deepEqual(await paths("fetchUserProfile"), ["notes/code.md"], "the whole identifier");
  assert.deepEqual(await paths("qlcodename"), ["notes/a.md", "notes/b.md"], "an alias finds its target by anchor text");
});
