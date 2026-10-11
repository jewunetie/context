/**
 * The folder walk cannot starve (pre-existing issue 8). A context with more
 * top-level folders than the pass's budget used to list the same first folders
 * on every pass, and the listing left too little for a single note read, so the
 * index never built at all (budget 50, 60 folders). The pass now leaves room to
 * work and resumes the walk at the first folder the last pass did not finish.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the listing work floor back to 2 (no room left to fetch)         1 here
 *   the stored cursor ignored (walk always from the first folder)    1 here
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearchBudget } from "../src/search/maintain.js";
import { MANIFEST_KEY, parseManifest, serializeManifest, syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { r2LikeBucket } from "./store/fixtures.mjs";

const FOLDERS = 60;
const isIndexable = (key) => key.endsWith(".md");
const name = (folder) => `f${String(folder).padStart(2, "0")}`;

async function bucket() {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    for (let note = 0; note < 2; note += 1) {
      await store.put(`${name(folder)}/n${note}.md`, `# Note\n\nkestrel ${name(folder)}word n${note}\n`);
    }
  }
  return store;
}

const found = async (store, query) =>
  (await searchIndexedNotes(store, { isVisible: () => true, isIndexable, query, budget: createSearchBudget(600) }))
    .hits.map((hit) => hit.key);

test("a budget below the folder count still builds the index and reaches every folder", async () => {
  const store = await bucket();
  const cursors = [];
  let passes = 0;
  for (; passes < 30; passes += 1) {
    await syncShardedIndex(store, { budget: createSearchBudget(50), isIndexable });
    cursors.push(parseManifest(store.objects.get(MANIFEST_KEY).body, 1e9)?.freshness.listCursor);
    // Converged once every folder's notes are indexed; truncated stays true by design.
    let missing = 0;
    for (let folder = 0; folder < FOLDERS; folder += 1) {
      if ((await found(store, `${name(folder)}word`)).length !== 2) missing += 1;
    }
    if (missing === 0) break;
  }
  assert.ok(passes < 30, "the last folder was never indexed");
  assert.ok(cursors[0], "the first pass records where the walk stopped");
  for (let folder = 0; folder < FOLDERS; folder += 1) {
    assert.equal((await found(store, `${name(folder)}word`)).length, 2, name(folder));
  }
});

test("a budget that covers the listing still lists everything in one pass and clears the cursor", async () => {
  const store = await bucket();
  const pass = await syncShardedIndex(store, { budget: createSearchBudget(600), isIndexable });
  assert.equal(pass.listingTruncated, false);
  assert.equal(parseManifest(store.objects.get(MANIFEST_KEY).body, 1e9).freshness.listCursor, null);
});

test("the cursor survives the manifest's serialization, and a malformed one refuses the manifest", async () => {
  const store = await bucket();
  await syncShardedIndex(store, { budget: createSearchBudget(50), isIndexable });
  const body = store.objects.get(MANIFEST_KEY).body;
  const manifest = parseManifest(body, 1e9);
  assert.equal(typeof manifest.freshness.listCursor, "string");
  assert.equal(parseManifest(serializeManifest(manifest), 1e9).freshness.listCursor, manifest.freshness.listCursor);
  const broken = JSON.parse(body);
  broken.freshness.listCursor = 7;
  assert.equal(parseManifest(JSON.stringify(broken), 1e9), null);
});

test("freshness.listCursor is an extra optional field: a manifest without it parses, an unknown sibling is ignored", async () => {
  const store = await bucket();
  await syncShardedIndex(store, { budget: createSearchBudget(50), isIndexable });
  const stored = JSON.parse(store.objects.get(MANIFEST_KEY).body);
  assert.equal(typeof stored.freshness.listCursor, "string");

  // An older writer's manifest has no cursor.
  const { listCursor, ...legacy } = stored.freshness;
  const older = parseManifest(JSON.stringify({ ...stored, freshness: legacy }), 1e9);
  assert.equal(older.freshness.listCursor, null);
  assert.equal(older.freshness.pending, stored.freshness.pending);

  // A reader ignores a freshness field it does not know, which is the property
  // an older reader had when this one was added. Checked against the real
  // previous parser (git show 54e80748~1:.../serialize.js) when it was added:
  // it parsed this manifest and returned its pending count.
  const newer = parseManifest(JSON.stringify({ ...stored, freshness: { ...stored.freshness, futureField: 1 } }), 1e9);
  assert.equal(newer.freshness.pending, stored.freshness.pending);
  assert.equal("futureField" in newer.freshness, false);
});
