/**
 * SEARCH INDEX v3 WRITER: revisioned shards, conditional publication and the
 * switch plumbing (`src/search/shards/revisions.js`, `shards/sync.js`,
 * CONTRACT-v3.md "The writer").
 *
 * With the switch off nothing under `.context/search/v3/` is written and v2 is
 * maintained exactly as before. With it on, every touched shard is written to
 * a new content-addressed revision key, the version 4 manifest names each
 * shard's exact key and digest, and the manifest write is the single
 * conditional commit point, so a pass that loses it leaves only unreferenced
 * revisions behind and a reader pinned to an older manifest keeps reading the
 * revisions that manifest names.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   v3 shard written to one fixed key per shard id, unconditionally          9
 *   revision put not awaited (manifest published before its shards)          3
 *   v3 manifest write ignores its etag (unconditional)                       2
 *   v3 written with the switch off (writer ignores the format)               3
 *   `parseManifestV4` accepts a null shard key whose stats hold documents    1
 *   `built` set without the `pending === 0 && !truncated` check              1
 *   query tokenizer taken from the configured format, not the served one     1
 *   query always parsed and scored with tokenizer 1                          1
 *   snippet lines cut with tokenizer 1 under a tokenizer 2 index             1
 *   chunked format indexes whole notes instead of `chunkNote` chunks         1
 *   resolved format not logged                                               1
 *   index built with tokenizer 1 whatever the format says                    1
 *   revision put without the create-only precondition                        2
 *   fix 1: every switched-on pass goes to v3 only (v2 frozen while building) 4
 *   fix 1: v2 still maintained after v3 is built and served                  2
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_FORMAT } from "../src/search/format.js";
import {
  DOCMAP_KEY,
  MANIFEST_KEY,
  V3_DOCMAP_KEY,
  V3_MANIFEST_KEY,
  V3_SHARD_PREFIX,
  V3_LAYOUT,
  emptyManifest,
  loadIndexManifest,
  loadShard,
  parseManifestV4,
  parseShard,
  serializeManifestV4,
  syncShardedIndex,
} from "../src/search/shards.js";
import { chunkNote } from "../src/search/chunk.js";
import { buildTermFilter } from "../src/search/filter.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { indexWrittenNotes } from "../src/search/writeProjection.js";
import { sha256Hex } from "../src/ingestion/inbox.js";
import { generateCorpus } from "./fixtures/searchCorpus.js";
import { memoryBucket } from "./store/fixtures.mjs";

const TOKENIZER_2 = { tokenizer: 2, chunk: null };
/** Tokenizer 1, no chunking, forced into the v3 namespace (the bench hook). */
const V3_TOKENIZER_1 = { tokenizer: 1, chunk: null, namespace: "v3" };
const CHUNKED_1000 = { tokenizer: 1, chunk: { target: 1000, max: 1500, cap: 64_000 } };
/** Small enough that 60 short notes need more than one shard. */
const SMALL_CAP = 40_000;
const REVISION_KEY = /^\.context\/search\/v3\/shards\/\d{3}-[0-9a-f]{16}\.json$/;

function conditionalBucket(options) {
  const bucket = memoryBucket(options);
  bucket.capabilities = { conditionalWrite: true, conditionalCreate: true };
  // A fixed upload time, so recency never breaks a tie differently per bucket.
  const list = bucket.list.bind(bucket);
  bucket.list = async (options) => {
    const listed = await list(options);
    for (const object of listed.objects) object.uploaded = new Date("2026-01-01T00:00:00Z");
    return listed;
  };
  return bucket;
}

function noteText(i, extra = "") {
  const filler = Array.from({ length: 40 }, (_, k) => `filler${(i * 7 + k) % 97}`).join(" ");
  return `# Note ${i}\n\nshared words about topic${i % 7} and item${i} ${extra}\n\n${filler}\n`;
}

async function seedNotes(bucket, count) {
  for (let i = 0; i < count; i += 1) await bucket.put(`notes/n${String(i).padStart(3, "0")}.md`, noteText(i));
}

function sync(store, options = {}) {
  return syncShardedIndex(store, { budget: 10_000, shardByteCap: SMALL_CAP, now: Date.parse("2026-01-01T00:00:00Z"), ...options });
}

async function buildUntilDone(store, options = {}) {
  for (let pass = 0; pass < 30; pass += 1) {
    const result = await sync(store, options);
    if (result.pending === 0 && !result.listingTruncated) return result;
  }
  throw new Error("index did not converge");
}

function v3Manifest(bucket) {
  const stored = bucket.objects.get(V3_MANIFEST_KEY);
  return stored ? parseManifestV4(stored.body) : null;
}

/** Every key the manifest names exists, parses, matches its digest and its filter. */
async function assertCoherent(bucket, manifest = v3Manifest(bucket)) {
  assert.ok(manifest, "a v3 manifest is published");
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const entry = manifest.shards[id];
    if (entry === null) {
      assert.equal(manifest.stats[id].docCount, 0, `shard ${id} has no key and no docs`);
      continue;
    }
    assert.match(entry.key, REVISION_KEY);
    const stored = bucket.objects.get(entry.key);
    assert.ok(stored, `shard ${id} revision ${entry.key} exists`);
    const shard = parseShard(stored.body);
    assert.ok(shard, `shard ${id} parses`);
    assert.equal(entry.digest, await sha256Hex(stored.body));
    assert.equal(entry.key.slice(V3_SHARD_PREFIX.length + 4, -5), entry.digest.slice(0, 16));
    // Rebuilt from the referenced shard and compared byte for byte.
    assert.equal(manifest.filters[id], buildTermFilter(shard.terms.keys()), `shard ${id} filter`);
  }
}

function search(store, query) {
  return searchIndexedNotes(store, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
  });
}

// -- the switch off --------------------------------------------------------------

test("default format: only v2 keys are written and search answers are unchanged", async () => {
  const answers = [];
  for (const format of [undefined, DEFAULT_FORMAT]) {
    const bucket = conditionalBucket();
    if (format) bucket.searchIndexFormat = format;
    await seedNotes(bucket, 60);
    await buildUntilDone(bucket);
    const indexKeys = [...bucket.objects.keys()].filter((key) => key.startsWith(".context/"));
    assert.ok(indexKeys.includes(MANIFEST_KEY));
    assert.ok(indexKeys.includes(DOCMAP_KEY));
    assert.deepEqual(indexKeys.filter((key) => !key.startsWith(".context/search/v2/")), []);
    // Hits sorted: equal scores across two shards may arrive in either order.
    const answer = await search(bucket, "topic3 item7");
    answer.hits.sort((x, y) => (x.key < y.key ? -1 : 1));
    answers.push(JSON.stringify(answer));
  }
  assert.equal(JSON.parse(answers[0]).hits.length, 10);
  assert.equal(answers[0], answers[1]);
});

// -- the switch on ---------------------------------------------------------------

test("v3 tokenizer 1 answers equal v2 answers on the bench 100-note corpus", async () => {
  const { notes, queries } = generateCorpus({ size: 100 });
  const v2 = conditionalBucket();
  const v3 = conditionalBucket();
  v3.searchIndexFormat = V3_TOKENIZER_1;
  for (const note of notes) {
    await v2.put(note.path, note.text);
    await v3.put(note.path, note.text);
  }
  await buildUntilDone(v2, { shardByteCap: undefined });
  await buildUntilDone(v3, { shardByteCap: undefined });
  const served = await loadIndexManifest(v3, createSearchBudget(10), 0);
  assert.equal(served.layout, V3_LAYOUT);
  await assertCoherent(v3);
  for (const { query } of queries) {
    const a = await search(v2, query);
    const b = await search(v3, query);
    assert.deepEqual(b.hits, a.hits, query);
    assert.equal(b.matchCount, a.matchCount, query);
  }
});

test("revision keys are content addressed and the manifest names key and digest", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const manifest = v3Manifest(bucket);
  assert.ok(manifest.shardCount >= 2, "the fixture spans several shards");
  assert.equal(manifest.built, true);
  assert.deepEqual(manifest.format, TOKENIZER_2);
  assert.ok(bucket.objects.has(V3_DOCMAP_KEY));
  assert.ok(bucket.objects.has(MANIFEST_KEY), "v2 is maintained while v3 builds (fix round 1)");
  await assertCoherent(bucket);
});

test("a manifest is published only after every revision it names is stored", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  const put = bucket.put.bind(bucket);
  let checked = 0;
  bucket.put = async (key, value, options) => {
    if (key === V3_MANIFEST_KEY) {
      const manifest = parseManifestV4(value);
      for (const entry of manifest.shards) {
        if (entry) assert.ok(bucket.objects.has(entry.key), `${entry.key} stored before the manifest`);
      }
      checked += 1;
    } else if (key.startsWith(V3_SHARD_PREFIX)) {
      // A slow shard write: a manifest that does not wait for it is caught.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return put(key, value, options);
  };
  await buildUntilDone(bucket);
  await bucket.put("notes/n001.md", noteText(1, "zebra"));
  await buildUntilDone(bucket);
  assert.ok(checked >= 2);
  await assertCoherent(bucket);
});

test("concurrent passes: the loser's revisions are unreferenced and the winner is coherent", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);

  const put = bucket.put.bind(bucket);
  const writesA = [];
  let pauseA = null;
  let releaseA = null;
  let inA = true;
  bucket.put = async (key, value, options) => {
    if (inA && key.startsWith(V3_SHARD_PREFIX)) {
      writesA.push(key);
      if (!pauseA) {
        // A has fetched its notes and is about to store its first revision.
        pauseA = new Promise((resolve) => (releaseA = resolve));
        await pauseA;
      }
    }
    return put(key, value, options);
  };

  await bucket.put("notes/n005.md", noteText(5, "alpha"));
  const passA = sync(bucket);
  for (let wait = 0; !pauseA && wait < 2000; wait += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(pauseA, "pass A writes a v3 revision");
  inA = false;
  await put("notes/n005.md", noteText(5, "bravo"));
  const resultB = await sync(bucket);
  const winner = v3Manifest(bucket);
  inA = true;
  releaseA();
  const resultA = await passA;

  assert.equal(resultB.committed, true);
  assert.equal(resultA.committed, false, "the second manifest write loses");
  const final = v3Manifest(bucket);
  assert.deepEqual(final.shards, winner.shards, "the loser changed nothing the winner published");
  const referenced = new Set(final.shards.filter(Boolean).map((entry) => entry.key));
  assert.ok(writesA.length > 0);
  for (const key of writesA) assert.equal(referenced.has(key), false, `${key} is the loser's`);
  await assertCoherent(bucket);
  const answer = await search(bucket, "bravo");
  assert.equal(answer.hits.length, 1);
});

test("a pass never writes to a key any published manifest references", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  const put = bucket.put.bind(bucket);
  const referenced = new Set();
  bucket.put = async (key, value, options) => {
    const written = await put(key, value, options);
    if (written && key.startsWith(V3_SHARD_PREFIX)) {
      assert.equal(referenced.has(key), false, `${key} overwritten while referenced`);
    }
    if (written && key === V3_MANIFEST_KEY) {
      for (const entry of parseManifestV4(value).shards) if (entry) referenced.add(entry.key);
    }
    return written;
  };
  await buildUntilDone(bucket);
  for (const word of ["one", "two", "three"]) {
    await bucket.put("notes/n002.md", noteText(2, word));
    await Promise.all([sync(bucket), sync(bucket)]);
  }
  await buildUntilDone(bucket);
  assert.ok(referenced.size > 0);
});

test("a revision already present is never overwritten", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 4);
  const put = bucket.put.bind(bucket);
  const shardPuts = [];
  bucket.put = async (key, value, options) => {
    if (key.startsWith(V3_SHARD_PREFIX)) shardPuts.push(options);
    return put(key, value, options);
  };
  await buildUntilDone(bucket);
  assert.ok(shardPuts.length > 0);
  for (const options of shardPuts) assert.deepEqual(options, { onlyIf: { absent: true } });
});

test("built flips once, on the first complete pass, and stays true", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  const seen = [];
  for (let pass = 0; pass < 30; pass += 1) {
    const result = await sync(bucket, { backfillOps: 12 });
    seen.push(v3Manifest(bucket)?.built ?? false);
    if (result.pending === 0 && !result.listingTruncated) break;
  }
  assert.equal(seen[0], false, "a pass with work left is not built");
  assert.equal(seen.at(-1), true);
  assert.equal(seen.filter((built, i) => built !== (seen[i - 1] ?? false)).length, 1, "one flip");
  // More notes than one capped pass can reach: pending again, still built.
  for (let i = 60; i < 90; i += 1) await bucket.put(`notes/n${i}.md`, noteText(i));
  const capped = await sync(bucket, { backfillOps: 2 });
  assert.ok(capped.pending > 0);
  assert.equal(v3Manifest(bucket).built, true);
});

test("readers pinned to an older manifest still read its revisions", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const pinned = await loadIndexManifest(bucket, createSearchBudget(10), 0);
  assert.equal(pinned.layout, V3_LAYOUT);

  await bucket.put("notes/n003.md", noteText(3, "zanzibar"));
  await buildUntilDone(bucket);
  const current = await loadIndexManifest(bucket, createSearchBudget(10), 0);
  const changed = current.shards.findIndex((entry, id) => entry?.key !== pinned.shards[id]?.key);
  assert.ok(changed >= 0, "the edit wrote a new revision");
  const old = await loadShard(bucket, createSearchBudget(10), 0, changed, undefined, pinned);
  const fresh = await loadShard(bucket, createSearchBudget(10), 0, changed, undefined, current);
  assert.equal(old.terms.has("zanzibar"), false);
  assert.equal(fresh.terms.has("zanzibar"), true);
});

test("budget exhaustion leaves the previous manifest and its revisions readable", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const before = bucket.objects.get(V3_MANIFEST_KEY).body;
  for (let i = 0; i < 10; i += 1) await bucket.put(`notes/n00${i}.md`, noteText(i, "later"));
  // Enough to read the manifest, the docmap and list, not to store a shard.
  await sync(bucket, { budget: 4 });
  const after = v3Manifest(bucket);
  assert.ok(after);
  await assertCoherent(bucket, parseManifestV4(before));
  await assertCoherent(bucket, after);
});

test("a crash mid-build leaves the old manifest serving", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  const before = bucket.objects.get(V3_MANIFEST_KEY).body;

  for (let i = 0; i < 60; i += 1) await bucket.put(`notes/n${String(i).padStart(3, "0")}.md`, noteText(i, "crash"));
  const put = bucket.put.bind(bucket);
  let shardWrites = 0;
  bucket.put = async (key, value, options) => {
    if (key.startsWith(V3_SHARD_PREFIX) && ++shardWrites === 2) throw new Error("worker killed");
    return put(key, value, options);
  };
  await assert.rejects(sync(bucket), /worker killed/);
  assert.equal(bucket.objects.get(V3_MANIFEST_KEY).body, before);
  await assertCoherent(bucket);
  const served = await loadIndexManifest(bucket, createSearchBudget(10), 0);
  assert.equal(served.layout, V3_LAYOUT);
});

test("a backend that ignores preconditions: the pass completes and labels nothing new", async () => {
  const plain = conditionalBucket();
  const weak = conditionalBucket({ ignoreIfMatch: true });
  for (const bucket of [plain, weak]) {
    bucket.searchIndexFormat = TOKENIZER_2;
    await seedNotes(bucket, 10);
  }
  const a = await buildUntilDone(plain);
  const b = await buildUntilDone(weak);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
  assert.equal(b.committed, true);
  assert.equal(v3Manifest(weak).built, true);
  const answer = await search(weak, "item3");
  assert.equal(answer.indexIncomplete, false);
  assert.equal(answer.hits.length, 1);
});

test("a fresh v3 manifest is a create-only write where the store supports it", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 3);
  const put = bucket.put.bind(bucket);
  const manifestPuts = [];
  bucket.put = async (key, value, options) => {
    if (key === V3_MANIFEST_KEY) manifestPuts.push(options ?? null);
    return put(key, value, options);
  };
  await sync(bucket);
  await bucket.put("notes/n000.md", noteText(0, "again"));
  await sync(bucket);
  assert.deepEqual(manifestPuts[0], { onlyIf: { absent: true } });
  assert.ok(manifestPuts[1]?.onlyIf?.etagMatches);
});

// -- the manifest codec (controller amendment a) --------------------------------

test("parseManifestV4 refuses a null shard key over a shard that holds documents", () => {
  const manifest = emptyManifest(2);
  manifest.format = TOKENIZER_2;
  manifest.built = true;
  manifest.stats[1].docCount = 3;
  manifest.shards = [null, null];
  assert.equal(parseManifestV4(serializeManifestV4(manifest)), null);
  manifest.stats[1].docCount = 0;
  assert.ok(parseManifestV4(serializeManifestV4(manifest)));
});

// -- the index and the query switch tokenizer together (amendment c) ------------

test("served v3 with tokenizer 2 is queried with tokenizer 2", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await bucket.put("notes/a.md", "# A\n\n数据库迁移计划已经确认\n");
  await buildUntilDone(bucket);
  // Tokenizer 1 reads this as one run, which no tokenizer 2 term equals and no
  // fuzzy match reaches; tokenizer 2 as words and two-character pieces.
  const answer = await search(bucket, "迁移计划");
  assert.deepEqual(answer.hits.map((hit) => hit.key), ["notes/a.md"]);
  assert.ok(answer.hits[0].snippets.length > 0, "snippet lines use the same tokenizer");
});

test("tokenizer 2 configured but v2 served is queried with tokenizer 1", async () => {
  const bucket = conditionalBucket();
  await bucket.put("notes/a.md", "# A\n\nmeet at the café\n");
  await buildUntilDone(bucket);
  bucket.searchIndexFormat = TOKENIZER_2;
  // No v3 index yet: v2 serves, and tokenizer 2 would fold this to "cafe".
  const answer = await search(bucket, "café");
  assert.deepEqual(answer.hits.map((hit) => hit.key), ["notes/a.md"]);
});

// -- chunking comes from the format (amendment b) --------------------------------

test("a chunked format indexes the chunks chunkNote returns for the format", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = CHUNKED_1000;
  const long = Array.from({ length: 12 }, (_, i) => `## Part ${i}\n\n${"words ".repeat(60)}section${i}\n`).join("\n");
  await bucket.put("notes/long.md", long);
  await bucket.put("notes/empty.md", "");
  await buildUntilDone(bucket);
  // Read from the published v3 revisions: while v3 builds, a pass returns the served (v2) shards.
  const docs = v3Manifest(bucket).shards.filter(Boolean)
    .flatMap((entry) => [...parseShard(bucket.objects.get(entry.key).body).docs.entries()]);
  const chunks = chunkNote("notes/long.md", long, CHUNKED_1000.chunk).chunks;
  assert.ok(chunks.length > 1);
  const longDocs = docs.filter(([, doc]) => doc.notePath === "notes/long.md");
  assert.deepEqual(longDocs.map(([key]) => key).sort(), chunks.map((_, i) => `notes/long.md#c${i}`).sort());
  // An empty (or encrypted) note still records its version.
  assert.ok(docs.some(([, doc]) => doc.notePath === "notes/empty.md"));
  const again = await sync(bucket);
  assert.equal(again.pending, 0);
  assert.equal(again.changed, false);
});

// -- one log line per pass (amendment e) -----------------------------------------

async function formatLines(run) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.includes("search-index-format"));
}

test("the resolved format is logged once per v3 pass, with counts and no note content", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 3);
  assert.deepEqual(await formatLines(() => sync(bucket)), [], "the default format logs nothing new");
  bucket.searchIndexFormat = TOKENIZER_2;
  const lines = await formatLines(() => sync(bucket));
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.event, "search-index-format");
  assert.equal(line.namespace, "v3");
  assert.equal(line.tokenizer, 2);
  assert.equal(line.chunk, null);
  assert.equal(typeof line.built, "boolean");
  assert.equal(typeof line.pending, "number");
  assert.equal(lines[0].includes("notes/"), false);
});

test("the v3 log line reports built and pending: pending while building, built once served", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  bucket.searchIndexFormat = TOKENIZER_2;
  const building = [];
  for (let pass = 0; pass < 40; pass += 1) {
    const lines = await formatLines(() => sync(bucket, { backfillOps: 20 }));
    assert.equal(lines.length, 1);
    building.push(JSON.parse(lines[0]));
    if (building.at(-1).built) break;
  }
  assert.equal(building[0].built, false);
  assert.ok(building[0].pending > 0, "the first limited pass leaves notes pending");
  assert.equal(building.at(-1).built, true);
  assert.equal(building.at(-1).pending, 0);
  // Once served, the line keeps saying built.
  const after = JSON.parse((await formatLines(() => sync(bucket)))[0]);
  assert.equal(after.built, true);
});

// -- v2 stays current until v3 is served (fix round 1) ---------------------------

async function writeNote(bucket, path, text) {
  const { etag } = await bucket.put(path, text);
  await indexWrittenNotes(bucket, [{ path, version: etag, size: text.length }]);
}

test("switch on, v3 not built: a note written through the write path is found", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  bucket.searchIndexFormat = TOKENIZER_2;
  await writeNote(bucket, "notes/new.md", "# New\n\nthe quokka arrived\n");
  assert.equal((await loadIndexManifest(bucket, createSearchBudget(10), 0)).format.tokenizer, 1, "v2 serves");
  assert.deepEqual((await search(bucket, "quokka")).hits.map((hit) => hit.key), ["notes/new.md"]);
});

test("switch on, v3 not built: full passes keep the served v2 index current", async () => {
  const bucket = conditionalBucket();
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  bucket.searchIndexFormat = TOKENIZER_2;
  await bucket.put("notes/late.md", "# Late\n\na wombat appeared\n");
  await sync(bucket, { backfillOps: 12 });
  assert.equal(v3Manifest(bucket)?.built ?? false, false, "v3 is still building");
  assert.deepEqual((await search(bucket, "wombat")).hits.map((hit) => hit.key), ["notes/late.md"]);
});

test("once v3 is built and served, written notes reach v3 and v2 maintenance stops", async () => {
  const bucket = conditionalBucket();
  bucket.searchIndexFormat = TOKENIZER_2;
  await seedNotes(bucket, 60);
  await buildUntilDone(bucket);
  assert.equal((await loadIndexManifest(bucket, createSearchBudget(10), 0)).layout, V3_LAYOUT);
  const v2Before = bucket.objects.get(MANIFEST_KEY).body;
  await writeNote(bucket, "notes/new.md", "# New\n\nthe quokka arrived\n");
  assert.deepEqual((await search(bucket, "quokka")).hits.map((hit) => hit.key), ["notes/new.md"]);
  await sync(bucket);
  assert.equal(bucket.objects.get(MANIFEST_KEY).body, v2Before);
});
