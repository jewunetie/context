/**
 * Where a sync pass writes: revisioned shards under one manifest (CONTRACT.md
 * "Revisioned shards").
 *
 * - **Revisioned shards.** A touched shard is stored under a new
 *   content-addressed key (`revisionKey`, ruling OPEN-58), and the manifest's
 *   `shards[id]` names that key and its full SHA-256. A reader that loaded an
 *   older manifest keeps reading the revisions it names, because nothing is
 *   ever rewritten in place. Superseded revisions are collected by `gc.js`.
 * - **The manifest is the single commit point.** It is written after every
 *   revision it names has landed, conditional on the etag read at the top of
 *   the pass, or create-only where no manifest existed and the store supports
 *   it. A pass that loses leaves only revisions nothing references. A stored
 *   manifest of another `INDEX_FORMAT_VERSION` parses as absent but still has
 *   an etag, so the rebuilt manifest replaces it conditionally.
 */

import { subDocumentsFor } from "../commsIndex.js";
import { sha256Hex } from "../../ingestion/inbox.js";
import { MANIFEST_KEY, DOCMAP_KEY } from "./constants.js";
import { revisionKey } from "./placement.js";
import { parseManifest, serializeManifest } from "./serialize.js";

const createOnly = { onlyIf: { absent: true } };

export const INDEX_WRITER = Object.freeze({
  manifestKey: MANIFEST_KEY,
  docmapKey: DOCMAP_KEY,
  parseManifest,
  serializeManifest,
  /** Chunk documents (`subDocumentsFor`, CONTRACT.md "Chunked notes"). */
  subDocuments: subDocumentsFor,
  /**
   * A new revision, and the manifest in memory names it only once it has
   * landed. Create-only where the store supports it, so an object some
   * manifest references is never written again; a refusal there means the
   * same bytes are already stored under the same content address. `gc.js`
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
    if (etag) return store.put(MANIFEST_KEY, body, { onlyIf: { etagMatches: etag } });
    return store.capabilities?.conditionalCreate ? store.put(MANIFEST_KEY, body, createOnly) : store.put(MANIFEST_KEY, body);
  },
});
