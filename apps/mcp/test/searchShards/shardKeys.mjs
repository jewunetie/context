/**
 * Where a shard lives. The index stores each shard under a content-addressed
 * revision key that only the manifest names, so a test finds a shard's key by
 * reading the manifest out of the bucket it is looking at.
 */

import { MANIFEST_KEY, parseManifest } from "../../src/search/shards.js";

/** The stored key of shard `id` in `bucket`'s index, or `null` when no manifest names one. */
export function shardKeyIn(bucket, id) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  const manifest = raw ? parseManifest(raw.body) : null;
  return manifest?.shards?.[id]?.key ?? null;
}

/** Every stored shard revision key in `bucket`, referenced or not. */
export function shardRevisionKeys(bucket) {
  return [...bucket.objects.keys()].filter((key) => key.startsWith(".context/search/index/shards/"));
}

/** The shard revision keys the manifest names (the live ones), in shard id order. */
export function liveShardKeys(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  const manifest = raw ? parseManifest(raw.body) : null;
  return (manifest?.shards ?? []).filter(Boolean).map((entry) => entry.key);
}
