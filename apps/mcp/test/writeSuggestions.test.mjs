/**
 * Link suggestions wired into `write_note` (Task 23, AGENT-LINKS 13.3 to
 * 13.7). Driven through the real `toolWriteNote` over a `memoryBucket` whose
 * graph is projected and whose sharded search index is converged, as
 * graphSuggest.test.mjs builds it; the protocol checks go through the real
 * worker and JSON-RPC handler.
 *
 * The write is the product and the suggestions are optional (P5): with
 * suggestions off, skipped, failing or timed out, the result text is today's
 * text byte for byte apart from the appended block, and the note, its audit
 * row and the search index are what they would have been without them.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file, then in remember.test.mjs.
 *
 *   suggestAfterWrite's catch rethrows                                      1 (throw inside the step), 0
 *     (the throwing search store does not reach it: retrieval absorbs store
 *     faults as partial or skipped, Task 22 ruling, so that test guards the
 *     write and the block, not the catch)
 *   remember passes linkSuggestions: true                                   0, 1
 *   opt-out (anything but false) instead of the dispatch-only flag          6, 1
 *   audience from the pre-write overrides                                   2 (team note, visibility flips)
 *   no graph floor in the suggestions' share                                1 (default budget 8)
 *   submitted content diffed instead of the merged text                     1 (collaborative)
 *   structuredContent for every protocol revision                           1 (tools/call)
 *   encrypted note not skipped                                              1 (encrypted)
 *   kill switch ignored (block appended at budget 0)                        1 (kill switch)
 *   invocation pool ignored                                                 1 (pool)
 *   graph hook call removed                                                 1 (link-only follow-up)
 *   Not caught: the SUGGEST_SUBREQUEST_CAP removed (one shard never needs
 *   more than 40 for two sections); `before` taken from the stored body on a
 *   collaborative note (the stored Markdown equals the merged document here).
 *
 * Fix round 1 (each new test red first against 91fcec88; counts span this
 * file, graphSuggest, graphRetrieve and remember):
 *   the MCP handler does not announce a batch's calls                       1 (JSON-RPC batch)
 *   upcoming calls left out of the reserve                                  3 (batch, pool, claim views)
 *   a claim never released after its graph update                           3 (batch, pool, claim views)
 *   a fixed 40-op cap put back on suggestions                               1 (claim views)
 *   block shown when the budget has nothing above the floor                 1 (configuration)
 *   structuredContent put back on the result                                5 (tools/call, appended-only checks)
 *   move jobs not passed to each section's retrieval                        4 (graphSuggest: read once, unreadable once, budget, CPU deadline)
 *   a null job list treated as unread (read again)                          1 (graphSuggest: unreadable once)
 * (Rows above this round's predate it; the structuredContent row there is
 * superseded: no revision gets structuredContent now.)
 *
 * Phase 4 final fix: graph updates went back to a per-write budget (as on
 * the Phase 3 head) and the pool now governs suggestions only, so the
 * floor-reservation rows above (announced calls, claim release, claim views)
 * describe removed code; the claim-views test went with it. New:
 *   graph update drawn from the request pool again                          1 (legacy batches at 8 and 80) plus
 *     the six-write pool test
 *   (sabotage counts in phase-4-final-fix-report.md)
 *
 * Labels and hints (owner decision 2026-10-07; both new tests red first):
 *   afterWrite lists share links for a teammate                             1 (teammate)
 *   the listing not passed to suggestLinks                                  1 (owner write)
 *   (no catch on the listing in afterWrite is not caught: suggestLinks
 *   handles a rejected listing itself)
 *
 * RED: 14 of 15 failed before the wiring (the op-bound test passed: the
 * graph hook was already bounded), and the remember check failed on its
 * positive control.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { callTool } from "../src/tools/dispatch.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey, nodeKey, pathHash } from "../src/graph/keys.js";
import { parseNode } from "../src/graph/records.js";
import { projectNote } from "../src/graph/project.js";
import { encryptNote } from "../src/encryption.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { DOCMAP_KEY, syncShardedIndex } from "../src/search/shards.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { memoryBucket } from "./store/fixtures.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const clock = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const CAPS = { conditionalWrite: true, conditionalCreate: true };
const WS = "w_suggest";
const KEY = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const indexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));
const RULES = [
  { prefix: "notes", vis: "team" },
  { prefix: "private", vis: "private" },
];
const CORPUS = {
  "notes/survey.md": "# Survey\n\nThe kestrel harbor survey results from the coast.\n",
  "notes/fog.md": "# Fog\n\nThe lighthouse fog signal log kept by the keeper.\n",
  "private/secret.md": "# Secret\n\nThe kestrel harbor survey secret budget figures.\n",
};
const TWO = "# New\n\n## Harbor\n\nThe kestrel harbor survey continues.\n\n## Fog\n\nThe lighthouse fog signal sounded for the keeper.\n";

async function bucketWith(notes = CORPUS, caps = CAPS) {
  const bucket = memoryBucket();
  bucket.capabilities = caps;
  for (const [path, body] of Object.entries(notes)) await bucket.put(path, body);
  await initGraphManifest(bucket, big(), { mode: "conditional", now: clock });
  for (const [path, body] of Object.entries(notes)) {
    const { state } = await projectNote(bucket, path, body, "1", { budget: big(), gen: "1", mode: "conditional", now: clock });
    assert.equal(state, "projected", path);
  }
  const m = JSON.parse(bucket.objects.get(graphManifestKey()).body);
  await bucket.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "ready", sweepComplete: true } }));
  for (let pass = 0; pass < 60; pass += 1) {
    const p = await syncShardedIndex(bucket, { budget: createSearchBudget(4000), isIndexable: indexable });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  return bucket;
}

/**
 * The bucket as a request's store: every op logged as `method:key`, an
 * optional hook before each, an owner actor and the deployment budget.
 */
function asStore(bucket, { budget = 80, hook = () => {} } = {}) {
  const store = {
    capabilities: bucket.capabilities,
    actor: { workspaceId: WS, userId: "u_owner" },
    writeEnrichBudget: budget,
    log: [],
    objects: bucket.objects,
  };
  for (const m of ["get", "put", "delete", "list", "head"]) {
    if (typeof bucket[m] !== "function") continue;
    store[m] = async (...a) => {
      const key = `${m}:${String(m === "list" ? a[0]?.prefix : a[0])}`;
      store.log.push(key);
      await hook(key);
      return bucket[m](...a);
    };
  }
  return store;
}

const write = (store, args, { scope = "private", overrides = new Map(), suggest = true, now } = {}) =>
  toolWriteNote(store, scope, RULES, overrides, args, suggest ? { linkSuggestions: true, ...(now && { now }) } : {});
const textOf = (result) => result.content[0].text.replace(/etag [^)\s]+/g, "etag E");
/**
 * The appended block read back from the text, the only place it is carried
 * (fix round 1: no structuredContent): `{ status, candidates: [{ path, section }] }`.
 */
function blockOf(result) {
  const text = result.content[0].text;
  const at = text.indexOf("\nLink suggestions");
  if (at < 0) return undefined;
  const [head, ...lines] = text.slice(at + 1).split("\n");
  const status = /^Link suggestions(?: \((\w+)\):|: (\w+)\.$)/.exec(head);
  assert.ok(status, head);
  return {
    status: status[1] ?? status[2],
    candidates: lines.map((line) => ({ path: /^- (\S+) \(/.exec(line)[1], section: /^- \S+ \("((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? null })),
  };
}
const paths = (block) => block.candidates.map((c) => c.path);
const etagOf = (result) => /etag ([^)\s]+)/.exec(result.content[0].text)[1];
const searchOps = (store) => store.log.filter((op) => op.includes(".context/search/"));
const enrichOps = (store) => store.log.filter((op) => !op.includes(".context/moves/"));
// The write itself maintains the search index, so suggestion work shows only
// as search ops beyond the same call's with suggestions unable to run.
// Audit keys carry a time and a random id.
const audited = (s) => String(s).replace(/\.context\/audit\/[^"\s]+\.json/g, ".context/audit/A.json");
const extraSearch = (on, off) => searchOps(on).length - searchOps(off).length;

/** Today's result plus exactly one appended block, and no other field. */
function assertAppended(result, baseline) {
  assert.equal(result.isError, undefined, result.content[0].text);
  const got = textOf(result);
  const want = textOf(baseline);
  assert.ok(got.startsWith(`${want}\nLink suggestions`), `${got}\n---\n${want}`);
  assert.ok(blockOf(result));
  assert.deepEqual(Object.keys(result), Object.keys(baseline));
}

/** Every stored object outside the derived graph, with times and etags normalised. */
function stored(bucket) {
  const norm = (s) => audited(s).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T").replace(/\b1\d{12}\b/g, "N").replace(/"etag":"[^"]*"/g, '"etag":"E"');
  return Object.fromEntries(
    [...bucket.objects]
      .filter(([k]) => !k.startsWith(".context/graph/"))
      .map(([k, v]) => [norm(k), norm(typeof v.body === "string" ? v.body : new TextDecoder().decode(v.body))]),
  );
}

test("a plain write gets the block appended; text, note, audit row and index are otherwise today's", async () => {
  const args = { path: "notes/new.md", content: TWO };
  const baseBucket = await bucketWith();
  const baseline = await write(asStore(baseBucket), args, { suggest: false });
  assert.equal(baseline.structuredContent, undefined);
  const bucket = await bucketWith();
  const result = await write(asStore(bucket), args);
  assertAppended(result, baseline);
  const block = blockOf(result);
  assert.equal(block.status, "ready");
  assert.ok(paths(block).includes("notes/survey.md"), JSON.stringify(block));
  assert.ok(paths(block).includes("notes/fog.md"), JSON.stringify(block));
  assert.deepEqual(stored(bucket), stored(baseBucket));
});

test("kill switch: budget 0 is today's result exactly, with no graph or search op", async () => {
  const args = { path: "notes/new.md", content: TWO };
  const plain = asStore(await bucketWith(), { budget: 0 });
  const baseline = await write(plain, args, { suggest: false });
  const store = asStore(await bucketWith(), { budget: 0 });
  const result = await write(store, args);
  const norm = (r) => JSON.stringify(r).replace(/etag [^)\s"]+/g, "etag E");
  assert.equal(norm(result), norm(baseline));
  assert.equal(result.structuredContent, undefined);
  assert.deepEqual(store.log.map(audited), plain.log.map(audited));
  assert.deepEqual(store.log.filter((op) => op.includes(".context/graph/")), []);
});

test("a budget at or under the default of 8 (configuration) omits the block; the write is today's exactly", async () => {
  const args = { path: "notes/new.md", content: `${TWO}See [[notes/fog]].\n` };
  for (const budget of [1, 8]) {
    const plain = asStore(await bucketWith(), { budget });
    const baseline = await write(plain, args, { suggest: false });
    const store = asStore(await bucketWith(), { budget });
    const result = await write(store, args);
    assert.equal(textOf(result), textOf(baseline), `budget ${budget}`);
    assert.deepEqual(Object.keys(result), Object.keys(baseline));
    assert.deepEqual(store.log.map(audited), plain.log.map(audited), `budget ${budget}`);
  }
});

test("a search store that throws: the write is today's and the block says so without failing it", async () => {
  const args = { path: "notes/new.md", content: TWO };
  const baseBucket = await bucketWith();
  const baseline = await write(asStore(baseBucket), args, { suggest: false });
  const bucket = await bucketWith();
  // Armed once the write's own index maintenance has finished (its last op),
  // so only suggestion work meets the failing store.
  let armed = false;
  const store = asStore(bucket, {
    hook: (op) => {
      if (armed && op.includes(".context/search/")) throw new Error("search store down");
      if (op === `put:${DOCMAP_KEY}`) armed = true;
    },
  });
  const result = await write(store, args);
  assertAppended(result, baseline);
  assert.ok(armed, "the failure was armed");
  assert.ok(["partial", "skipped", "none"].includes(blockOf(result).status), blockOf(result).status);
  assert.deepEqual(stored(bucket), stored(baseBucket));
});

test("a throw inside the suggestion step itself is unavailable, never a failed write", async () => {
  const args = { path: "notes/new.md", content: TWO };
  const baseBucket = await bucketWith();
  const baseline = await write(asStore(baseBucket), args, { suggest: false });
  const bucket = await bucketWith();
  const result = await write(asStore(bucket), args, {
    now: () => {
      throw new Error("clock down");
    },
  });
  assertAppended(result, baseline);
  assert.equal(blockOf(result).status, "unavailable");
  assert.deepEqual(blockOf(result).candidates, []);
  assert.deepEqual(stored(bucket), stored(baseBucket));
});

test("deadline: once the injected clock passes it, no further search op starts", async () => {
  const args = { path: "notes/new.md", content: TWO };
  const plain = asStore(await bucketWith());
  const baseline = await write(plain, args, { suggest: false });
  let time = clock;
  const store = asStore(await bucketWith(), {
    hook: (op) => {
      if (op.includes(".context/search/")) time += 1000;
    },
  });
  const result = await write(store, args, { now: () => time });
  assertAppended(result, baseline);
  assert.equal(extraSearch(store, plain), 1, JSON.stringify(searchOps(store)));
  assert.ok(["skipped", "partial"].includes(blockOf(result).status), blockOf(result).status);
});

test("a link-only follow-up write is skipped, and its graph facts still update", async () => {
  const run = async (suggest) => {
    const store = asStore(await bucketWith());
    const first = await write(store, { path: "notes/new.md", content: "# New\n\nThe kestrel harbor survey continues.\n" }, { suggest: false });
    store.log.length = 0;
    const second = await write(
      store,
      { path: "notes/new.md", content: "# New\n\nThe [[notes/survey|kestrel harbor survey]] continues.\n", expected_etag: etagOf(first) },
      { suggest },
    );
    assert.equal(second.isError, undefined, second.content[0].text);
    return { store, second };
  };
  const off = await run(false);
  const { store, second } = await run(true);
  assert.equal(blockOf(second).status, "skipped");
  assert.equal(extraSearch(store, off.store), 0, "no retrieval for a link-only change");
  const got = await store.objects.get(nodeKey("1", await pathHash("notes/new.md")));
  assert.match(JSON.stringify(parseNode(got.body, "notes/new.md")), /notes\/survey/);
});

test("a team note's write never suggests a private candidate; a private note's may", async () => {
  const content = "# Plan\n\nThe kestrel harbor survey budget is next.\n";
  const team = await write(asStore(await bucketWith()), { path: "notes/plan.md", content, visibility: "team", confirm_team_publish: true });
  assert.match(team.content[0].text, /visibility: team/);
  assert.ok(paths(blockOf(team)).includes("notes/survey.md"), JSON.stringify(blockOf(team)));
  assert.ok(!paths(blockOf(team)).includes("private/secret.md"), JSON.stringify(blockOf(team)));
  const own = await write(asStore(await bucketWith()), { path: "notes/plan.md", content });
  assert.match(own.content[0].text, /visibility: private/);
  assert.ok(paths(blockOf(own)).includes("private/secret.md"), JSON.stringify(blockOf(own)));
});

test("the write's own visibility change decides the audience: team to private, and private to team", async () => {
  const v1 = "# Plan\n\nNothing yet.\n";
  const v2 = "# Plan\n\nThe kestrel harbor survey budget is next.\n";

  const toPrivate = asStore(await bucketWith());
  const created = await write(toPrivate, { path: "notes/plan.md", content: v1, visibility: "team", confirm_team_publish: true }, { suggest: false });
  const narrowed = await write(toPrivate, { path: "notes/plan.md", content: v2, visibility: "private", expected_etag: etagOf(created) });
  assert.match(narrowed.content[0].text, /visibility: private/);
  assert.ok(paths(blockOf(narrowed)).includes("private/secret.md"), JSON.stringify(blockOf(narrowed)));

  const toTeam = asStore(await bucketWith());
  const held = await write(toTeam, { path: "notes/plan.md", content: v1 }, { suggest: false });
  assert.match(held.content[0].text, /visibility: private/);
  const published = await write(
    toTeam,
    { path: "notes/plan.md", content: v2, visibility: "team", confirm_team_publish: true, expected_etag: etagOf(held) },
    { overrides: new Map([["notes/plan.md", "private"]]) },
  );
  assert.match(published.content[0].text, /visibility: team/);
  assert.ok(paths(blockOf(published)).includes("notes/survey.md"), JSON.stringify(blockOf(published)));
  assert.ok(!paths(blockOf(published)).includes("private/secret.md"), JSON.stringify(blockOf(published)));
});

test("post-commit ops: the graph update alone stays within WRITE_ENRICH_SUBREQUEST_BUDGET, and suggestions add at most as much again", async () => {
  const args = { path: "notes/new.md", content: `${TWO}See [[notes/fog]] and [[notes/survey]].\n` };
  const zero = asStore(await bucketWith(), { budget: 0 });
  await write(zero, args, { suggest: false });
  const floor = enrichOps(zero).length;
  for (const budget of [1, 8, 9, 20, 30, 48, 60, 80, 200]) {
    const graphOnly = asStore(await bucketWith(), { budget });
    await write(graphOnly, args, { suggest: false });
    assert.ok(enrichOps(graphOnly).length - floor <= budget, `budget ${budget}: graph update ${enrichOps(graphOnly).length - floor} ops`);
    const store = asStore(await bucketWith(), { budget });
    await write(store, args);
    const spent = enrichOps(store).length - floor;
    assert.ok(spent <= 2 * budget, `budget ${budget}: ${spent} ops after commit`);
  }
});

test("six writes sharing one suggestion pool at 80 all project", async () => {
  const run = async (suggest) => {
    const store = asStore(await bucketWith());
    // One invocation's suggestion pool, as the route makes it.
    store.writeEnrichPool = createSearchBudget(80);
    const deferred = [];
    store.defer = (promise) => deferred.push(promise);
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      const body = `# W${i}\n\n## Harbor\n\nThe kestrel harbor survey continues ${i} [[notes/survey]].\n\n## Fog\n\nThe lighthouse fog signal sounded ${i}.\n`;
      results.push(await write(store, { path: `notes/w${i}.md`, content: body }, { suggest }));
    }
    await Promise.all(deferred);
    const projected = [];
    for (let i = 0; i < 6; i += 1) projected.push(store.objects.has(nodeKey("1", await pathHash(`notes/w${i}.md`))));
    return { store, results, projected };
  };
  const off = await run(false);
  assert.deepEqual(off.projected, [true, true, true, true, true, true], "control: without suggestions all six project");
  const on = await run(true);
  assert.deepEqual(on.projected, [true, true, true, true, true, true]);
  assert.ok(on.results.every((r) => blockOf(r)), "every write carries a block");
  assert.equal(blockOf(on.results[0]).status, "ready");
  assert.ok(on.store.writeEnrichPool.spent <= 80);
});

test("one invocation's pool bounds every write's suggestions together; each graph update keeps its own budget", async () => {
  const writes = [
    { path: "notes/a.md", content: TWO },
    { path: "notes/b.md", content: TWO.replace("New", "Other") },
  ];
  const zero = asStore(await bucketWith(), { budget: 0 });
  for (const args of writes) await write(zero, args, { suggest: false });
  const store = asStore(await bucketWith(), { budget: 60 });
  store.writeEnrichPool = createSearchBudget(60);
  for (const args of writes) await write(store, args);
  const spent = enrichOps(store).length - enrichOps(zero).length;
  assert.ok(store.writeEnrichPool.spent > 0 && store.writeEnrichPool.spent <= 60, `pool spent ${store.writeEnrichPool.spent}`);
  assert.ok(spent <= 60 + 2 * 60, `${spent} ops after commit for two writes`);
});

test("a collaborative merged write diffs the merged text: a link another edit added is not suggested again", async () => {
  const store = asStore(await bucketWith());
  const v1 = "# New\n\n## Harbor\n\nNothing yet.\n";
  const created = await write(store, { path: "notes/new.md", content: v1 }, { suggest: false });
  const theirs = await write(store, { path: "notes/new.md", content: `${v1}\n## Links\n\nSee [[notes/survey]].\n`, expected_etag: etagOf(created) }, { suggest: false });
  assert.equal(theirs.isError, undefined, theirs.content[0].text);
  // The agent read v1 and submits a body without the other edit's link.
  const mine = await write(store, {
    path: "notes/new.md",
    content: "# New\n\n## Harbor\n\nThe kestrel harbor survey continues.\n",
    expected_etag: etagOf(created),
  });
  assert.equal(mine.isError, undefined, mine.content[0].text);
  const merged = await (await store.get("notes/new.md")).text();
  assert.match(merged, /kestrel harbor survey continues/);
  assert.match(merged, /\[\[notes\/survey\]\]/);
  const block = blockOf(mine);
  assert.ok(["ready", "none"].includes(block.status), block.status);
  assert.ok(!paths(block).includes("notes/survey.md"), JSON.stringify(block));
  assert.ok(block.candidates.every((c) => c.section === "Harbor"), JSON.stringify(block));
});

test("an encrypted note is skipped without any retrieval", async () => {
  const bucket = await bucketWith();
  const sealed = await encryptNote("# Locked\n\nOld words.\n", { workspaceId: WS, workspaceKey: KEY, keyId: "k1" });
  await bucket.put("notes/locked.md", sealed);
  const store = asStore(bucket);
  store.encryptionKey = { current: "k1", keys: { k1: KEY } };
  const etag = (await bucket.get("notes/locked.md")).etag;
  const args = { path: "notes/locked.md", content: "# Locked\n\nThe kestrel harbor survey secret.\n", expected_etag: etag };
  const result = await write(store, args);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(blockOf(result).status, "skipped");
  const offBucket = await bucketWith();
  await offBucket.put("notes/locked.md", sealed);
  const off = asStore(offBucket);
  off.encryptionKey = store.encryptionKey;
  await write(off, { ...args, expected_etag: (await offBucket.get("notes/locked.md")).etag }, { suggest: false });
  assert.equal(extraSearch(store, off), 0);
});

test("through dispatch: plain write_note gets the block; comments and forms never do and never search", async () => {
  // Each call on two identical worlds: budget 8 leaves suggestions nothing
  // (the graph keeps its floor), budget 80 lets them run. Only suggestion
  // work can make the second search more.
  const calls = [
    ["write_note", { path: "notes/talk.md", comment: { action: "add", quote: "free, you cheapo", text: "Tone the kestrel harbor survey down." } }],
    ["create_form", { path: "forms/survey.md", intro: "About the kestrel harbor survey.", fields: [{ name: "answer", type: "text", max: 100 }] }],
  ];
  const seed = { path: "notes/talk.md", content: "# Talk\n\nThe kestrel harbor survey is free, you cheapo.\n" };
  const run = async (budget) => {
    const store = asStore(await bucketWith(), { budget });
    const plain = await callTool("write_note", seed, store, "private");
    const plainOps = searchOps(store).length;
    const rest = [];
    for (const [name, args] of calls) {
      store.log.length = 0;
      const result = await callTool(name, args, store, "private");
      assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
      rest.push({ result, ops: searchOps(store) });
    }
    return { plain, plainOps, rest };
  };
  const low = await run(8);
  const high = await run(80);
  assert.match(high.plain.content[0].text, /\nLink suggestions \(ready\)/);
  assert.ok(high.plainOps > low.plainOps, "positive control: the plain write searched");
  for (const [i, [name]] of calls.entries()) {
    assert.doesNotMatch(JSON.stringify(high.rest[i].result), /Link suggestions|linkSuggestions/, name);
    assert.deepEqual(high.rest[i].ops, low.rest[i].ops, name);
  }
});

/* ------------------------- over the JSON-RPC handler ------------------------- */

const OWNER = `cat_suggest_owner_${"0".repeat(15)}`;
const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  NATIVE_BINDINGS: "SUGGEST_BUCKET",
  WRITE_ENRICH_SUBREQUEST_BUDGET: "80",
};
let restore;
before(async () => {
  const controlPlane = createControlPlaneStub();
  restore = controlPlane.install();
  controlPlane.addWorkspace("ws_suggest", "suggest", {
    provider: "r2-binding",
    bindingName: "SUGGEST_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  await controlPlane.addGrant({
    accessToken: OWNER,
    workspaceId: "ws_suggest",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_suggest",
    userId: "user_suggest",
  });
});
after(() => restore?.());

async function post(headers, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const parsed = JSON.parse(await response.text());
  await settle();
  return parsed;
}

test("tools/call write_note: the block is in the text for every revision, never structuredContent", async () => {
  const params = (path) => ({ name: "write_note", arguments: { path, content: "# Talk\n\nThe kestrel harbor survey continues.\n" } });
  const cases = [
    { label: "legacy, no header (2025-03-26)", headers: {} },
    { label: "legacy 2025-06-18", headers: { "MCP-Protocol-Version": "2025-06-18" } },
    { label: "legacy 2025-11-25", headers: { "MCP-Protocol-Version": "2025-11-25" } },
    { label: "modern 2026-07-28", modern: "2026-07-28" },
  ];
  for (const [i, c] of cases.entries()) {
    env.SUGGEST_BUCKET = await bucketWith();
    const path = `notes/talk${i}.md`;
    const result = c.modern
      ? (await post(
          { "MCP-Protocol-Version": c.modern, "Mcp-Method": "tools/call", "Mcp-Name": "write_note" },
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...params(path), _meta: { "io.modelcontextprotocol/protocolVersion": c.modern } } },
        )).result
      : (await post(c.headers, { jsonrpc: "2.0", id: 1, method: "tools/call", params: params(path) })).result;
    assert.equal(result.isError, undefined, `${c.label}: ${JSON.stringify(result)}`);
    assert.equal(result.content.length, 1, c.label);
    assert.equal(result.content[0].type, "text", c.label);
    assert.match(result.content[0].text, new RegExp(`^written: ${path} \\(etag [^)]+\\)\\nvisibility: private\\nLink suggestions \\(ready\\)`), c.label);
    assert.equal(result.structuredContent, undefined, c.label);
  }
});

test("a legacy JSON-RPC batch of six writes at budget 80: every note projects and every write carries a block", async () => {
  const notes = { ...CORPUS };
  for (let i = 0; i < 40; i += 1) notes[`notes/n${i}.md`] = `kestrel harbor survey lighthouse fog ${i}`;
  const bucket = await bucketWith(notes);
  env.SUGGEST_BUCKET = bucket;
  const body = (i) => `# W${i}\n\n## Harbor\n\nThe kestrel harbor survey continues ${i} [[notes/n${i}]].\n\n## Fog\n\nThe lighthouse fog signal sounded ${i}.\n`;
  const batch = Array.from({ length: 6 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "tools/call",
    params: { name: "write_note", arguments: { path: `notes/w${i}.md`, content: body(i) } },
  }));
  const replies = await post({ "MCP-Protocol-Version": "2025-03-26" }, batch);
  assert.equal(replies.length, 6);
  for (const reply of replies) assert.match(reply.result.content[0].text, /\nLink suggestions/, JSON.stringify(reply));
  const projected = [];
  for (let i = 0; i < 6; i += 1) projected.push(bucket.objects.has(nodeKey("1", await pathHash(`notes/w${i}.md`))));
  assert.deepEqual(projected, [true, true, true, true, true, true]);
});

test("a batch's reads hold nothing back: nine read_note then one write_note at 80 still suggests", async () => {
  env.SUGGEST_BUCKET = await bucketWith();
  const reads = Array.from({ length: 9 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "tools/call",
    params: { name: "read_note", arguments: { path: "notes/survey.md" } },
  }));
  const write = {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "write_note", arguments: { path: "notes/last.md", content: TWO } },
  };
  const replies = await post({ "MCP-Protocol-Version": "2025-03-26" }, [...reads, write]);
  assert.equal(replies.length, 10);
  const text = replies.at(-1).result.content[0].text;
  assert.match(text, /\nLink suggestions \((ready|partial)\)/, text);
});

test("graph updates keep their own per-write budget: legacy batches at 8 (2, 3 writes) and 80 (11, 12 writes) project every note", async () => {
  const notes = { ...CORPUS };
  for (let i = 0; i < 40; i += 1) notes[`notes/n${i}.md`] = `kestrel harbor survey lighthouse fog ${i}`;
  const body = (i) => `# W${i}\n\n## Harbor\n\nThe kestrel harbor survey continues ${i} [[notes/n${i}]].\n\n## Fog\n\nThe lighthouse fog signal sounded ${i}.\n`;
  const missed = [];
  try {
    for (const [budget, n] of [["8", 2], ["8", 3], ["80", 11], ["80", 12]]) {
      env.WRITE_ENRICH_SUBREQUEST_BUDGET = budget;
      const bucket = await bucketWith(notes);
      env.SUGGEST_BUCKET = bucket;
      const batch = Array.from({ length: n }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: "write_note", arguments: { path: `notes/w${i}.md`, content: body(i) } },
      }));
      const replies = await post({ "MCP-Protocol-Version": "2025-03-26" }, batch);
      assert.equal(replies.length, n);
      const projected = [];
      for (let i = 0; i < n; i += 1) projected.push(bucket.objects.has(nodeKey("1", await pathHash(`notes/w${i}.md`))));
      if (projected.includes(false)) missed.push(`budget ${budget}, ${n} writes: ${projected.map(Number).join("")}`);
    }
  } finally {
    env.WRITE_ENRICH_SUBREQUEST_BUDGET = "80";
  }
  assert.deepEqual(missed, []);
});

// Owner decision (2026-10-07): one share-link listing per owner write, none for
// a teammate; store ops unchanged by it.
function withLinks(store, list) {
  const calls = [];
  Object.defineProperty(store, "links", { value: { list: () => (calls.push("list"), list()) }, enumerable: false });
  return calls;
}
const LABEL_ARGS = { path: "notes/new.md", content: TWO };

test("owner write: one link listing, labels for the note and an anyone-linked folder; store ops identical to no listing", async () => {
  const plainStore = asStore(await bucketWith());
  const plain = await write(plainStore, LABEL_ARGS);
  const store = asStore(await bucketWith());
  const calls = withLinks(store, async () => [{ entryPath: "notes", audience: "anyone" }, { entryPath: "notes/fog.md", audience: "name" }, { entryPath: "notes/survey.md", audience: "email" }]);
  const result = await write(store, LABEL_ARGS);
  assert.deepEqual(calls, ["list"]);
  assert.ok(!result.content[0].text.includes("shared outside team"), "an anyone link wins over a name or email one");
  const text = result.content[0].text;
  // A link opens only what the team can read, so the private note under the
  // linked folder is not shared publicly; its team neighbour is.
  assert.match(text, /^Link suggestions \(ready\): this note is private\. /m);
  assert.match(text, /^- notes\/survey\.md \("Harbor"; text_match\) \[team, shared publicly; link to it from this note\]/m);
  assert.deepEqual(store.log.map(audited), plainStore.log.map(audited));
  assert.ok(!plain.content[0].text.includes("shared publicly"));
  const teamStore = asStore(await bucketWith());
  withLinks(teamStore, async () => [{ entryPath: "notes", audience: "anyone" }]);
  const published = await write(teamStore, { ...LABEL_ARGS, visibility: "team", confirm_team_publish: true });
  assert.match(published.content[0].text, /^Link suggestions \(ready\): this note is team, shared publicly\. /m);
});

test("a teammate's write makes no link listing and never says shared publicly; a failed listing labels nothing", async () => {
  const store = asStore(await bucketWith());
  const calls = withLinks(store, async () => [{ entryPath: "notes", audience: "anyone" }, { entryPath: "notes/fog.md", audience: "email" }]);
  const result = await write(store, LABEL_ARGS, { scope: "team" });
  assert.ok(!result.content[0].text.includes("shared outside team"), result.content[0].text);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(calls, []);
  assert.equal(blockOf(result).status, "ready");
  assert.ok(!result.content[0].text.includes("shared publicly"), result.content[0].text);
  assert.match(result.content[0].text, /\[team; link to it from this note, or back from it\]/);

  const failing = asStore(await bucketWith());
  const failed = withLinks(failing, async () => { throw new Error("control plane down"); });
  const out = await write(failing, LABEL_ARGS);
  assert.deepEqual(failed, ["list"]);
  assert.equal(blockOf(out).status, "ready");
  assert.ok(!out.content[0].text.includes("shared publicly"));
});
