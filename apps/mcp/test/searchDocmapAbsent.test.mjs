/**
 * A pass that cannot read the docmap must not rebuild a shard from empty
 * (pre-existing issue 9). The docmap is the diff surface; with it absent the
 * manifest still says the shard holds documents, and a write's pass used to
 * start from an empty shard and publish a revision holding only the written
 * note, dropping every other document from the served index.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   `hasStored` trusting only the docmap (the old line)   1 here (the write pass; the full-pass test guards a path that already held)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearchBudget } from "../src/search/maintain.js";
import { DOCMAP_KEY, syncShardedIndex } from "../src/search/shards.js";
import { indexWrittenNotes } from "../src/search/writeProjection.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const isIndexable = (key) => key.endsWith(".md");

async function converged() {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (let i = 0; i < 8; i += 1) await store.put(`notes/n${i}.md`, `# N${i}\n\nolddoc${i} kestrel\n`);
  for (let pass = 0; pass < 10; pass += 1) {
    const result = await syncShardedIndex(store, { budget: createSearchBudget(5000), isIndexable });
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  return store;
}

const found = async (store, query) =>
  (await searchIndexedNotes(store, { isVisible: () => true, isIndexable, query, budget: createSearchBudget(600) }))
    .hits.map((hit) => hit.key).sort();

test("non-vacuous: the converged index finds every note", async () => {
  const store = await converged();
  assert.equal((await found(store, "kestrel")).length, 8);
  assert.ok(store.objects.has(DOCMAP_KEY));
});

test("a write's pass with the docmap absent keeps every other document in the served index", async () => {
  const store = await converged();
  store.objects.delete(DOCMAP_KEY);
  await store.put("notes/new.md", "# New\n\nfresh kestrel\n");
  await indexWrittenNotes(store, [{ path: "notes/new.md", version: "w1", size: 20 }]);
  const paths = await found(store, "kestrel");
  assert.equal(paths.length, 9, paths.join(","));
  assert.ok(paths.includes("notes/new.md") && paths.includes("notes/n0.md"));
});

test("a full pass with the docmap absent keeps every document too", async () => {
  const store = await converged();
  store.objects.delete(DOCMAP_KEY);
  await store.put("notes/new.md", "# New\n\nfresh kestrel\n");
  for (let pass = 0; pass < 5; pass += 1) {
    const result = await syncShardedIndex(store, { budget: createSearchBudget(5000), isIndexable });
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  assert.equal((await found(store, "kestrel")).length, 9);
});
