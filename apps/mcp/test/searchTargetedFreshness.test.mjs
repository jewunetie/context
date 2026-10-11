/**
 * A write's targeted pass records no freshness (pre-existing leftover 1). The
 * condition guarding the freshness block mixed `&&` and `||`, so a targeted
 * pass whose own numbers differed overwrote the record: a manifest with
 * pending 7 came back with pending 0 and listedAt now, clearing the
 * "catching up" banner it had not earned.
 *
 * ## Sabotage record
 *
 *   the old `!targeted && A || B || C` condition restored       1 here
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearchBudget } from "../src/search/maintain.js";
import { MANIFEST_KEY, parseManifest, serializeManifest, syncShardedIndex } from "../src/search/shards.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const isIndexable = (key) => key.endsWith(".md");

test("a targeted pass keeps the stored pending count, listedAt and truncated flag", async () => {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  await store.put("a.md", "# A\n\nkestrel one\n");
  await syncShardedIndex(store, { budget: createSearchBudget(100), isIndexable });

  const manifest = parseManifest(store.objects.get(MANIFEST_KEY).body, 1e9);
  manifest.freshness = { listedAt: "2020-01-01T00:00:00.000Z", pending: 7, truncated: true, listCursor: null };
  await store.put(MANIFEST_KEY, serializeManifest(manifest));

  await store.put("b.md", "# B\n\nkestrel two\n");
  const only = new Map([["b.md", { version: store.objects.get("b.md").etag ?? "", uploaded: new Date().toISOString() }]]);
  await syncShardedIndex(store, { budget: createSearchBudget(24), isIndexable, only });

  const after = parseManifest(store.objects.get(MANIFEST_KEY).body, 1e9);
  assert.deepEqual(
    { ...after.freshness },
    { listedAt: "2020-01-01T00:00:00.000Z", pending: 7, truncated: true, listCursor: null },
  );
});
