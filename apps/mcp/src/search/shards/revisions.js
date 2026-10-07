/**
 * Where a sync pass writes, per index format (CONTRACT-v3.md "The writer").
 *
 * `syncPass` (`sync.js`) is one loop for both namespaces and asks this module for
 * the few things that differ: the keys, the manifest codec, how a note becomes
 * documents, how a shard is stored and how the manifest is committed. The v2
 * writer below is today's behaviour exactly; the v3 writer is chosen only when
 * `store.searchIndexFormat` says so (`usesV3`), which nothing sets unless the
 * switch vars are.
 *
 * What v3 adds, and why:
 *
 * - **Revisioned shards.** A touched shard is stored under a new
 *   content-addressed key (`revisionKey`, ruling OPEN-58), and the manifest's
 *   `shards[id]` names that key and its full SHA-256. A reader that loaded an
 *   older manifest keeps reading the revisions it names, because nothing is
 *   ever rewritten in place. Revisions are retained; Task 32 collects them.
 * - **The manifest is the single commit point.** It is written after every
 *   revision it names has landed, conditional on the etag read at the top of
 *   the pass, or create-only where no manifest existed and the store supports
 *   it. A pass that loses leaves only revisions nothing references.
 * - **`built`** is set by the first full pass that ends with nothing pending
 *   and the listing complete, and is never cleared; readers serve v3 only
 *   once it is true.
 *
 * Revisioning applies to v3 only (ruling OPEN-74); v2 keeps its fixed keys.
 */

import { isChannelDayIndexPath, subDocumentsFor } from "../commsIndex.js";
import { chunkNote } from "../chunk.js";
import { formatsEqual, readFormat, usesV3 } from "../format.js";
import { sha256Hex } from "../../ingestion/inbox.js";
import { MANIFEST_KEY, DOCMAP_KEY, V3_MANIFEST_KEY, V3_DOCMAP_KEY } from "./constants.js";
import { V3_LAYOUT } from "./io.js";
import { revisionKey, shardKey } from "./placement.js";
import { parseManifest, parseManifestV4, serializeManifest, serializeManifestV4 } from "./serialize.js";

export const V2_WRITER = Object.freeze({
  v3: false,
  tokenizer: 1,
  manifestKey: MANIFEST_KEY,
  docmapKey: DOCMAP_KEY,
  parseManifest,
  serializeManifest: (manifest) => serializeManifest(manifest),
  subDocuments: subDocumentsFor,
  /** Fixed key, unconditional: the v2 manifest is its concurrency point. */
  async putShard(store, _manifest, id, body) {
    await store.put(shardKey(id), body);
    return true;
  },
  /**
   * Conditional on the etag read at the top of the pass; unconditional where
   * no manifest existed (CONTRACT.md v2, unchanged in Phase 5).
   */
  putManifest(store, body, etag) {
    return etag
      ? store.put(MANIFEST_KEY, body, { onlyIf: { etagMatches: etag } })
      : store.put(MANIFEST_KEY, body);
  },
});

/**
 * The writer for one pass over `store`. Logs the resolved format once when it
 * is not the default: identifiers only, never a path or a term.
 */
export function writerFor(store) {
  const configured = store?.searchIndexFormat;
  if (!usesV3(configured)) return V2_WRITER;
  const format = readFormat(configured);
  try {
    console.log(
      JSON.stringify({
        event: "search-index-format",
        workspace: store.actor?.workspaceId,
        namespace: "v3",
        tokenizer: format.tokenizer,
        chunk: format.chunk?.target ?? null,
      })
    );
  } catch {
    // Instrumentation never fails a pass (`trace.js`).
  }
  return v3Writer(format);
}

function v3Writer(format) {
  const createOnly = { onlyIf: { absent: true } };
  return {
    v3: true,
    tokenizer: format.tokenizer,
    manifestKey: V3_MANIFEST_KEY,
    docmapKey: V3_DOCMAP_KEY,
    /** A v3 manifest built for another format is a rebuild: read as absent. */
    parseManifest(text, cap) {
      const manifest = parseManifestV4(text, cap);
      if (!manifest || !formatsEqual(manifest.format, format)) return null;
      manifest.layout = V3_LAYOUT;
      return manifest;
    },
    serializeManifest(manifest, { pending, truncated, targeted }) {
      // A targeted pass did not list, so it cannot say the index is complete.
      if (!targeted && pending === 0 && !truncated) manifest.built = true;
      manifest.format = format;
      manifest.shards = Array.from({ length: manifest.shardCount }, (_, id) => manifest.shards?.[id] ?? null);
      return serializeManifestV4(manifest);
    },
    subDocuments(path, full) {
      // Channel-day notes keep one document per message. An empty note (or an
      // encrypted one, whose indexable text is empty) has no chunks and keeps
      // its single whole-note document, so its version is still recorded.
      if (!format.chunk || isChannelDayIndexPath(path)) return subDocumentsFor(path, full);
      const { chunks } = chunkNote(path, full, format.chunk);
      if (chunks.length === 0) return subDocumentsFor(path, full);
      // lean: chunk title and anchor are Task 36 (OPEN-53).
      return chunks.map((chunk) => ({ key: `${path}#c${chunk.index}`, notePath: path, anchor: null, content: chunk.text, comms: null, chunk: chunk.index }));
    },
    /**
     * A new revision, and the manifest in memory names it only once it has
     * landed. Create-only where the store supports it, so an object some
     * manifest references is never written again; a refusal there means the
     * same bytes are already stored under the same content address. Task 32
     * deletes revisions, and a logical-delete tombstone can make a create-only
     * put refuse a key whose object is gone, so a refusal is believed only
     * after `exists` confirms the object; otherwise the shard is reported as
     * not persisted and the manifest never names it.
     */
    async putShard(store, manifest, id, body) {
      const digest = await sha256Hex(body);
      const key = revisionKey(id, digest);
      if (manifest.shards?.[id]?.key !== key) {
        const created = await (store.capabilities?.conditionalCreate ? store.put(key, body, createOnly) : store.put(key, body));
        if (created === null && typeof store.exists === "function" && !(await store.exists(key))) return false;
      }
      manifest.shards = manifest.shards || [];
      manifest.shards[id] = { key, digest };
      return true;
    },
    putManifest(store, body, etag) {
      if (etag) return store.put(V3_MANIFEST_KEY, body, { onlyIf: { etagMatches: etag } });
      return store.capabilities?.conditionalCreate
        ? store.put(V3_MANIFEST_KEY, body, createOnly)
        : store.put(V3_MANIFEST_KEY, body);
    },
  };
}
