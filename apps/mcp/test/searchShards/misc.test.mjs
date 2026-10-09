/**
 * A note indexed by its head at the v2 cap, and `loadShard`, the shared
 * per-shard loader every pass and every query call through. See
 * searchShards.test.mjs for the module overview and the sabotage-testing
 * record.
 */

import {
  R2Store,
  converge,
  createBucket,
  createSearchBudget,
  loadShard,
  shardHasNote,
  storedManifest,
  shardKeyIn,
  syncShardedIndex,
} from "./fixtures.mjs";

export async function runSearchShardsMiscChecks(check) {
  // A note is indexed in chunks

  {
    // A note is indexed as chunks up to the chunk cap (64,000 characters),
    // not by its first 2,048 characters. Pinned by the token count the chunks
    // hold between them, not by a search hit: a hit-based probe measures the
    // expander.
    const bucket = createBucket();
    bucket.seed("1-projects/edge.md", "abc ".repeat(4000));
    const pass = await syncShardedIndex(new R2Store(bucket), { budget: createSearchBudget(20) });
    const chunks = [...pass.shards.get(0).docs.values()].filter((doc) => doc.notePath === "1-projects/edge.md");
    check(
      "a long note is indexed as chunks that together hold all of its 16,000 characters",
      // 4,000 = 16,000 characters of "abc " groups. A literal, not derived
      // from a constant under test.
      chunks.length > 1 && chunks.reduce((sum, doc) => sum + doc.len.body, 0) === 4000
    );
  }

  // -- the shared loader ---------------------------------------------------

  {
    const bucket = createBucket();
    bucket.seed("1-projects/note.md", "# Note\n\nA TAKAHE, once.\n");
    const store = new R2Store(bucket);
    await converge(store);
    const manifest = storedManifest(bucket);

    const budget = createSearchBudget(3);
    const loaded = await loadShard(store, budget, 0, 0, undefined, manifest);
    // Shard 7 has no stored revision: an empty shard, at no cost. A revision the
    // manifest names but the bucket lacks is a null, and that read is paid for.
    const unnamed = await loadShard(store, budget, 0, 7, undefined, manifest);
    const missing = await loadShard(
      store,
      budget,
      0,
      0,
      undefined,
      { ...manifest, shards: [{ key: ".context/search/index/shards/000-deadbeefdeadbeef.json", digest: "0".repeat(64) }] }
    );
    check(
      "loadShard reads one shard for one budget op, an unnamed shard is empty and free, and a named one that is not there is null",
      loaded !== null &&
        shardHasNote(loaded, "1-projects/note.md") &&
        unnamed?.docs.size === 0 &&
        missing === null &&
        budget.spent === 2
    );
    const starved = createSearchBudget(1);
    const first = await loadShard(store, starved, 1, 0, undefined, manifest);
    check(
      "and it spends nothing it was told to reserve, answering null rather than dipping in",
      first === null && starved.spent === 0 && starved.remaining === 1
    );
    const key = shardKeyIn(bucket, 0);
    bucket.failGetKeys.add(key);
    const refused = await loadShard(store, createSearchBudget(3), 0, 0, undefined, manifest);
    bucket.failGetKeys.delete(key);
    check(
      "a shard the backend refuses is a null, not an exception out of the search",
      refused === null
    );
  }
}
