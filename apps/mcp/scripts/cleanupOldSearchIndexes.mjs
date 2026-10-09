#!/usr/bin/env node
/**
 * Operator tool: remove the orphaned search objects the single-index change
 * left in a workspace's bucket. A HUMAN runs it, once per workspace, after
 * confirming the new index is complete. See docs/decisions/search.md,
 * "Cleaning up the old search objects".
 *
 * Removes exactly these and nothing else:
 *   .context/search/v2/*        old index data
 *   .context/search/v3/*        old staging index data
 *   .context/search-v1.json     the legacy single-file index
 * It never touches notes, `.context/graph/`, `.context/moves/`, the live index
 * under `.context/search/index/`, or any other key.
 *
 * Dry run unless `--delete` is passed: counts and bytes per prefix, nothing
 * deleted. It refuses (exit 1, deletes nothing) unless the live manifest under
 * `.context/search/index/` loads at the current format version and reports a
 * complete pass (`indexIsBehind` is false).
 *
 *   CONTEXT_S3_ENDPOINT=... CONTEXT_S3_BUCKET=... CONTEXT_S3_ACCESS_KEY_ID=... \
 *   CONTEXT_S3_SECRET_ACCESS_KEY=... [CONTEXT_S3_REGION=auto] \
 *   node apps/mcp/scripts/cleanupOldSearchIndexes.mjs [--delete]
 *
 * The store is an S3Store wrapped in `withLogicalDelete`, the same stack the
 * gateway uses, so deletes follow the repo's rules for the bucket.
 */

import { pathToFileURL } from "node:url";

import { createSearchBudget } from "../src/search/maintain.js";
import { loadIndexManifest } from "../src/search/shards.js";
import { indexIsBehind } from "../src/search/shards/shapes.js";

export const ORPHAN_PREFIXES = Object.freeze([".context/search/v2/", ".context/search/v3/"]);
export const LEGACY_KEY = ".context/search-v1.json";

const isOrphan = (key) => key === LEGACY_KEY || ORPHAN_PREFIXES.some((prefix) => key.startsWith(prefix));

/** Every object under `prefix`, following the listing's pages. */
async function listAll(store, prefix) {
  const found = [];
  let cursor;
  do {
    const page = await store.list({ prefix, ...(cursor && { cursor }) });
    for (const object of page?.objects ?? []) found.push({ key: object.key, size: Number(object.size) || 0 });
    cursor = page?.truncated ? page.cursor : undefined;
    if (page?.truncated && !cursor) throw new Error(`listing under ${prefix} is truncated without a cursor`);
  } while (cursor);
  return found;
}

/**
 * @param {object} store a ContextStore (list, get, delete), logical-delete wrapped
 * @param {{ apply?: boolean }} [options] `apply: true` deletes; the default lists only
 * @returns {Promise<{ ok: boolean, refused?: string, applied: boolean,
 *   report: {prefix: string, count: number, bytes: number}[], deleted: number }>}
 */
export async function cleanupOldSearchIndexes(store, { apply = false } = {}) {
  const manifest = await loadIndexManifest(store, createSearchBudget(10), 0);
  if (!manifest) {
    return { ok: false, applied: false, report: [], deleted: 0, refused: "no readable index manifest of the current format version under .context/search/index/" };
  }
  if (indexIsBehind(manifest.freshness)) {
    const { listedAt, pending, truncated } = manifest.freshness ?? {};
    return { ok: false, applied: false, report: [], deleted: 0, refused: `the index is not complete (listedAt ${listedAt ?? "none"}, pending ${pending ?? "unknown"}, truncated ${Boolean(truncated)})` };
  }

  const targets = [...ORPHAN_PREFIXES, LEGACY_KEY];
  const report = [];
  const keys = [];
  for (const target of targets) {
    const objects = (await listAll(store, target)).filter((o) => (target === LEGACY_KEY ? o.key === LEGACY_KEY : o.key.startsWith(target)));
    report.push({ prefix: target, count: objects.length, bytes: objects.reduce((sum, o) => sum + o.size, 0) });
    keys.push(...objects.map((o) => o.key));
  }

  let deleted = 0;
  if (apply) {
    for (const key of keys) {
      if (!isOrphan(key)) throw new Error(`refusing to delete ${key}`);
      await store.delete(key);
      deleted += 1;
    }
  }
  return { ok: true, applied: apply, report, deleted };
}

async function main() {
  const env = process.env;
  const need = (name) => {
    if (!env[name]) throw new Error(`${name} is required`);
    return env[name];
  };
  const { S3Store } = await import("../src/store/s3.js");
  const { withLogicalDelete } = await import("../src/store/logicalDelete.js");
  const store = withLogicalDelete(
    new S3Store({
      endpoint: need("CONTEXT_S3_ENDPOINT"),
      bucket: need("CONTEXT_S3_BUCKET"),
      accessKeyId: need("CONTEXT_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("CONTEXT_S3_SECRET_ACCESS_KEY"),
      region: env.CONTEXT_S3_REGION,
    }),
  );
  const result = await cleanupOldSearchIndexes(store, { apply: process.argv.includes("--delete") });
  if (!result.ok) {
    console.error(`Refused, nothing deleted: ${result.refused}`);
    process.exitCode = 1;
    return;
  }
  for (const { prefix, count, bytes } of result.report) console.log(`${prefix}  ${count} objects  ${bytes} bytes`);
  console.log(result.applied ? `Deleted ${result.deleted} objects.` : "Dry run, nothing deleted. Pass --delete to remove these.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
