import {
  MANIFEST_KEY,
  DOCMAP_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  SHARD_PARSE_BYTE_CAP,
  V3_MANIFEST_KEY,
  V3_DOCMAP_KEY,
} from "./constants.js";
import { parseManifest, parseManifestV4, parseDocmap, parseShard } from "./serialize.js";
import { shardKey } from "./placement.js";
import { DEFAULT_FORMAT, formatsEqual, usesV3 } from "../format.js";

// -- layouts (CONTRACT-v3.md) ------------------------------------------------

/** Today's index: fixed keys, one per shard id. */
export const V2_LAYOUT = Object.freeze({
  namespace: "v2",
  manifestKey: MANIFEST_KEY,
  docmapKey: DOCMAP_KEY,
  shardKeyFor: (id) => shardKey(id),
});

/** Any non-default format: the manifest names each shard's exact key; `null` is nothing stored. */
export const V3_LAYOUT = Object.freeze({
  namespace: "v3",
  manifestKey: V3_MANIFEST_KEY,
  docmapKey: V3_DOCMAP_KEY,
  shardKeyFor: (id, manifest) => manifest?.shards?.[id]?.key ?? null,
});

/** What a `null` shard key reads as: a shard holding nothing. */
const EMPTY_SHARD_TEXT = JSON.stringify({ version: 3, generatedAt: null, docs: [], terms: [] });

async function readManifestAt(store, budget, reserve, cap, key, parse) {
  if (!budget.take(reserve)) return null;
  const stored = await store.get(key);
  if (!stored) return null;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength > cap) return null;
  return parse(new TextDecoder().decode(bytes), cap);
}

// -- reading one shard -----------------------------------------------------

/**
 * Read the manifest, and nothing else. The query path's whole view of the
 * index.
 *
 * A search used to reach the manifest through `syncShardedIndex`, which meant
 * every search also listed the customer's bucket and indexed whatever it found
 * stale before answering. That is the 20-to-60-second search this whole
 * direction is about: the subrequest budget bounded what a search could
 * **spend** and nothing bounded what a person **waited for**. A search reads a
 * ready index now, and the maintenance that makes it ready runs behind the
 * response.
 *
 * One op (two when a non-default format is configured and its v3 index is
 * not served). The result carries `layout` and `format`, so callers never
 * re-decide which namespace they are reading. `null` for every way the manifest can fail to arrive — absent,
 * refused, oversized, corrupt, no budget — because to this caller they mean the
 * same thing: there is nothing here to answer from, say so and let the surface
 * decide what to do about it.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} [byteCap]
 * @returns {Promise<ReturnType<typeof emptyManifest>|null>}
 */
export async function loadIndexManifest(store, budget, reserve, byteCap = MANIFEST_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : MANIFEST_PARSE_BYTE_CAP;
  // The dual read (CONTRACT-v3.md). Only a configured, usable, non-default
  // format looks under `v3/` at all, and v3 is served only when it is built for
  // exactly that format; every other outcome, a read failure included, serves
  // v2 exactly as before.
  const format = store?.searchIndexFormat;
  if (usesV3(format)) {
    let v3 = null;
    try {
      v3 = await readManifestAt(store, budget, reserve, cap, V3_LAYOUT.manifestKey, parseManifestV4);
    } catch {
      v3 = null;
    }
    if (v3 && v3.built && formatsEqual(v3.format, format)) {
      v3.layout = V3_LAYOUT;
      return v3;
    }
  }
  const v2 = await readManifestAt(store, budget, reserve, cap, V2_LAYOUT.manifestKey, parseManifest);
  if (v2 === null) return null;
  v2.layout = V2_LAYOUT;
  v2.format = DEFAULT_FORMAT;
  return v2;
}

/**
 * Every note path the search index's docmap currently knows about, sorted.
 *
 * Built for link resolution (`docs/decisions/app-and-console.md`, "L1"): a
 * bare `[[name]]` in the editor and the `[[` completion both need the whole
 * bucket's note paths, and the file tree only knows the folders somebody has
 * expanded. Rather than a second index — a full bucket listing on its own
 * budget, paid on the customer's request quota just to learn what this module
 * already tracks — this reads the *diff surface* the sharded sync already
 * maintains behind every search's response.
 *
 * Two ops: the manifest (for its `shardCount`, which is what tells a docmap
 * apart from one for a different index layout) and then the docmap itself.
 * `null` for every way either can fail to arrive — no budget, absent,
 * refused, oversized, corrupt, or a docmap for a shard count the manifest
 * does not recognise — because to a caller resolving a link these all mean
 * the same thing: nothing here to resolve against yet. That is deliberately
 * an *honest failure* rather than a wrong one — a link that is not drawn yet,
 * never a link drawn at the wrong path — which is why this never falls back
 * to a listing: a derivative that is behind is exactly the failure mode this
 * function exists to report rather than paper over.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {object} [given] a manifest the caller already read, so it is not read twice
 * @returns {Promise<{ paths: string[], freshness: ReturnType<typeof emptyManifest>["freshness"] } | null>}
 */
export async function loadDocmapPaths(store, budget, reserve, given) {
  const manifest = given ?? (await loadIndexManifest(store, budget, reserve));
  if (manifest === null) return null;
  if (!budget.take(reserve)) return null;
  const stored = await store.get(manifest.layout.docmapKey);
  if (!stored) return null;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength > MANIFEST_PARSE_BYTE_CAP) return null;
  const docsByShard = parseDocmap(new TextDecoder().decode(bytes), manifest.shardCount);
  if (docsByShard === null) return null;
  const paths = new Set();
  for (const docs of docsByShard) {
    for (const path of docs.keys()) paths.add(path);
  }
  return { paths: [...paths].sort(), freshness: manifest.freshness };
}

/**
 * Read and parse one shard, for one budget op.
 *
 * The **one** loader: the query path streams shards through this and so does
 * the sync loop below, because a second reader is a second place for the byte
 * cap, the parse rules or the budget discipline to drift.
 *
 * `null` covers every way a shard can fail to arrive — no budget, absent,
 * refused by the backend, oversized, corrupt — on purpose: to every caller the
 * answer is the same, rebuild it from the notes. A caller that needs to tell a
 * budget refusal apart checks `budget.remaining` before calling, and the sync
 * loop below does exactly that, because "empty" and "could not look" must not
 * be confused where the next step is a write.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {ReturnType<typeof createSearchBudget>} budget
 * @param {number} reserve store ops kept back for the caller's later work
 * @param {number} id shard id
 * @param {number} [byteCap]
 * @param {object} [manifest] the loaded manifest, whose `layout` names the key; v2 when absent
 * @returns {Promise<ReturnType<typeof emptyShard>|null>}
 */
export async function loadShard(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP, manifest) {
  const bytes = await fetchShardBytes(store, budget, reserve, id, byteCap, manifest);
  return bytes ? decodeShard(bytes, byteCap) : null;
}

/**
 * The read half of `loadShard`: one shard's stored bytes, or `null`.
 *
 * Held apart from the parse so a caller can have several reads in flight and
 * still parse **one at a time** — the query walk does, in waves of
 * `SHARD_READ_CONCURRENCY`, which is the fetch/parse split CONTRACT.md § Query
 * named as the follow-up to its sequential walk. The memory bound v2 exists for
 * survives that only because what a wave holds is bytes: six `ArrayBuffer`s
 * under the cap is at most 12MB, where six *parsed* shards would be six times
 * the peak this whole format is arranged to keep at one.
 *
 * The byte cap is applied here rather than only at the parse, for the same
 * reason it always was — the length is read from the bytes, never from a
 * header, because the header is the backend's word for it — so an oversized
 * object is dropped before anything decodes it.
 *
 * `null` covers every way a read can fail: no budget, absent, refused by the
 * backend, oversized. `manifest` is as for `loadShard`. As with `loadShard`, a caller that must tell a budget
 * refusal from an absence checks `budget.remaining` before calling.
 */
export async function fetchShardBytes(store, budget, reserve, id, byteCap = SHARD_PARSE_BYTE_CAP, manifest) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  // The key comes from the manifest's layout; v2 when the caller passed none.
  // A v3 shard with no stored revision is empty, and costs no op to say so.
  const key = (manifest?.layout ?? V2_LAYOUT).shardKeyFor(id, manifest);
  if (key === null) return new TextEncoder().encode(EMPTY_SHARD_TEXT).buffer;
  if (!budget.take(reserve)) return null;
  try {
    const stored = await store.get(key);
    if (!stored) return null;
    const bytes = await stored.arrayBuffer();
    if (bytes.byteLength > cap) return null;
    return bytes;
  } catch {
    // One unreadable shard must not cost the whole search its answer. The op
    // was already spent, so a bucket of unreadable shards still terminates.
    return null;
  }
}

/** The parse half: bytes in, a shard or `null` out. Never throws. */
export function decodeShard(bytes, byteCap = SHARD_PARSE_BYTE_CAP) {
  const cap = Number.isFinite(byteCap) ? byteCap : SHARD_PARSE_BYTE_CAP;
  try {
    if (!bytes || bytes.byteLength > cap) return null;
    return parseShard(new TextDecoder().decode(bytes), cap);
  } catch {
    return null;
  }
}

