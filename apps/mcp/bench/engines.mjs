/**
 * The engines `run.mjs` scores (docs/design/link-graph/PLAN.md, Phases 0 and
 * 5). Each is the real search code over an in-memory bucket or `node:sqlite`;
 * nothing here re-implements ranking.
 *
 * - `buildBucketEngine` with no `format` is B0, today's bucket search, built
 *   and queried exactly as Phase 0 measured it.
 * - With a `format`, `store.searchIndexFormat` is set on the bucket, the
 *   index is built through the real dual pass until v3 is served, and the
 *   build refuses to return an arm whose served index is not v3 (the reader
 *   falls back to v2 silently, which would make the arm read as B0).
 * - With `graph` ("b2", "b3", "b4") the graph is built with Phase 2's
 *   `reconcileGraph`, called as `search/maintenance.js` calls it, until its
 *   health is ready, and each query goes through `retrieveCandidates` as
 *   `search/visibleNotes.js` sends a boosted search (`store.searchGraphBoost`
 *   is that function's switch; this calls the function it selects directly,
 *   so the D1 fast path and deferred maintenance are not in the measurement,
 *   as they are not for B0). Scope is "workspace", as in the fusion tests.
 * - With a format carrying `anchors` (B6), the graph is built first, then the
 *   v3 index reads anchor text from it; queries are lexical.
 * - `buildB5` is the Fast Search projection, unchanged.
 */

import { DatabaseSync } from "node:sqlite";

import { createSearchBudget } from "../src/search/maintain.js";
import { loadIndexManifest, syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { subDocumentsFor } from "../src/search/commsIndex.js";
import { DEFAULT_FORMAT } from "../src/search/format.js";
import { ANCHORS_UNREAD } from "../src/search/shards/constants.js";
import { censusFromManifest } from "../src/search/d1/backfill.js";
import { projectNote, upsertStatements } from "../src/search/d1/project.js";
import { answerFromProjection } from "../src/search/d1/serve.js";
import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphView } from "../src/graph/mode.js";
import { graphHealth } from "../src/graph/manifest.js";
import { retrieveCandidates } from "../src/graph/retrieve.js";
import { percentile } from "./metrics.js";

const encoder = new TextEncoder();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const isIndexable = (key) => key.endsWith(".md") && !key.startsWith(".context/");

/**
 * The in-memory bucket of `test/bench/shardSizing.mjs`, with latency. It
 * advertises conditional write and create and honours `onlyIf.absent` as well
 * as `etagMatches`, so the graph runs in conditional mode; the v2 index never
 * reads `capabilities`, and the B0 rows reproducing BASELINE.md is the check.
 */
export function createBucket(latency) {
  const objects = new Map();
  let etags = 0;
  return {
    capabilities: { conditionalWrite: true, conditionalCreate: true },
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      await sleep(latency);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      await sleep(latency);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent === true && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      await sleep(latency);
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      await sleep(latency);
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: encoder.encode(stored.body).length, uploaded: stored.uploaded, etag: stored.etag });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return { objects: page, delimitedPrefixes: [...prefixes], truncated, cursor: truncated ? keys[index - 1] : undefined };
    },
    setLatency(ms) {
      latency = ms;
    },
    bytesOf(key) {
      const stored = key ? objects.get(key) : null;
      return stored ? encoder.encode(stored.body).length : 0;
    },
  };
}

/** What the writer indexed: every whole-note or chunk document's length (message docs excluded). */
export function chunkSizes(notes, format) {
  const sizes = [];
  for (const note of notes) {
    for (const doc of subDocumentsFor(note.path, note.text, format ?? DEFAULT_FORMAT)) {
      if (doc.anchor === null) sizes.push(doc.content.length);
    }
  }
  return { docs: sizes.length, p50: percentile(sizes, 50), p95: percentile(sizes, 95), max: percentile(sizes, 100) };
}

/** The served index's costs: shard count, bytes, shed and partial notes. */
async function indexCosts(bucket, oversizedShards) {
  const manifest = await loadIndexManifest(bucket, createSearchBudget(1_000_000), 0);
  const layout = manifest.layout;
  let bytes = bucket.bytesOf(layout.manifestKey) + bucket.bytesOf(layout.docmapKey);
  for (let id = 0; id < manifest.shardCount; id += 1) bytes += bucket.bytesOf(layout.shardKeyFor(id, manifest));
  const count = (field) => manifest.stats.reduce((total, entry) => total + (entry[field]?.length ?? 0), 0);
  return {
    namespace: layout.namespace,
    shards: manifest.shardCount,
    bytes,
    shed: count("shedPaths"),
    partial: count("partialPaths"),
    oversizedShards,
  };
}

/** Notes in the served index whose anchor text is still to be read. */
async function unreadAnchors(bucket) {
  const manifest = await loadIndexManifest(bucket, createSearchBudget(1_000_000), 0);
  let count = 0;
  for (const shard of manifest?.docsByShard ?? []) for (const version of shard.values()) if (version.endsWith(ANCHORS_UNREAD)) count += 1;
  return count;
}

/** Graph passes, each a sync pass then `reconcileGraph` on one budget, as `maintenance.js` runs them. */
async function buildGraph(bucket, budget, maxPasses) {
  for (let passes = 1; passes <= maxPasses; passes += 1) {
    const spend = createSearchBudget(budget);
    const synced = await syncShardedIndex(bucket, { budget: spend });
    const freshness = synced.manifest?.freshness;
    await reconcileGraph(graphView(bucket, spend), spend, {
      census: censusFromManifest(synced.manifest),
      censusComplete: !synced.listingTruncated && Boolean(freshness?.listedAt) && !freshness?.truncated,
      censusListedAt: freshness?.pending === 0 ? freshness.listedAt : undefined,
      removedHints: synced.removed || [],
      isIndexable,
      now: Date.now(),
    });
    const health = await graphHealth(bucket, createSearchBudget(100));
    if (health.state === "ready" && !health.possiblyIncomplete) return passes;
  }
  throw new Error(`the graph was not ready after ${maxPasses} passes`);
}

/**
 * B0 (no `format`), or a v3 arm with an optional graph variant.
 *
 * @param {{ path: string, text: string }[]} notes
 * @param {{ latency: number, budget: number, format?: object | null, graph?: "b2" | "b3" | "b4" | null }} options
 */
export async function buildBucketEngine(notes, { latency, budget, format = null, graph = null }) {
  const bucket = createBucket(0);
  for (const note of notes) bucket.seed(note.path, note.text);
  // Anchor text reads the graph at index time, so the graph is built first
  // (over the v2 census), then the v3 index. Every note is visible.
  const anchorPasses = format?.anchors ? await buildGraph(bucket, budget, 4_000) : null;
  if (format) bucket.searchIndexFormat = format;
  // Built without latency: the build is not what is being measured, and at
  // 10,000 notes it would be most of the run. A v3 arm builds v2 first and v3
  // from the leftover of each pass, so it gets more passes.
  const maxPasses = format ? 4_000 : 400;
  let passes = 0;
  let last;
  for (; passes < maxPasses; passes += 1) {
    last = await syncShardedIndex(bucket, { budget: createSearchBudget(budget), visibilityOf: () => "team" });
    if (last.pending === 0 && !last.listingTruncated) break;
  }
  // Anchor reads a pass could not pay for are re-read later and are not
  // `pending` (anchors.js): keep passing until none is left unread.
  for (let more = 0; format?.anchors && more < maxPasses && (await unreadAnchors(bucket)) > 0; more += 1) {
    last = await syncShardedIndex(bucket, { budget: createSearchBudget(budget), visibilityOf: () => "team" });
    passes += 1;
  }
  const costs = await indexCosts(bucket, last.oversizedShards);
  if (format && costs.namespace !== "v3") throw new Error(`v3 was not served after ${passes + 1} passes`);
  const graphPasses = graph ? await buildGraph(bucket, budget, 4_000) : anchorPasses;
  bucket.setLatency(latency);
  let graphIncomplete = 0;
  return {
    passes: passes + 1,
    graphPasses,
    costs,
    chunks: chunkSizes(notes, format),
    get graphIncomplete() {
      return graphIncomplete;
    },
    async search(query) {
      const spend = createSearchBudget(budget);
      const options = {
        isVisible: () => true,
        isIndexable: (key) => key.endsWith(".md"),
        query,
        budget: spend,
        // As production runs it (src/search/visibleNotes.js): an empty answer
        // over a converged index buys a listing and asks again.
        refreshOnMiss: true,
      };
      const answer = graph
        ? await retrieveCandidates(bucket, { seed: { query }, intent: "search", variant: graph, scope: "workspace", search: options })
        : await searchIndexedNotes(bucket, options);
      if (answer.graphIncomplete) graphIncomplete += 1;
      return { paths: (answer.hits ?? []).map((hit) => hit.key), subrequests: spend.spent };
    },
  };
}

/* -- B5: the Fast Search projection -------------------------------------- */

/** The schema in `test/searchD1.test.mjs`, kept in step with `lib/d1.ts`. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
     path TEXT PRIMARY KEY, version TEXT NOT NULL, visibility TEXT NOT NULL,
     title TEXT NOT NULL, uploaded TEXT, chunks INTEGER NOT NULL,
     indexed_at TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_private_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_team_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
];

export function buildB5(notes, latency, budget) {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  for (const note of notes) {
    const projected = projectNote(note.path, { version: "v1", uploaded: null, visibility: note.visibility, content: note.text });
    for (const { sql, params } of upsertStatements(note.path, projected)) db.prepare(sql).run(...params);
  }
  const client = {
    async query(sql, params) {
      await sleep(latency);
      return db.prepare(sql).all(...params);
    },
  };
  return {
    async search(query) {
      const spend = createSearchBudget(budget);
      const answer = await answerFromProjection(client, { query, tier: "private", isVisible: () => true, budget: spend });
      return { paths: (answer?.hits ?? []).map((hit) => hit.key), subrequests: spend.spent };
    },
  };
}
