/**
 * What the last complete sweep covered (`health.sweepCensusAt`, Task 13,
 * OPEN-23): the listing time of the search census the sweep started on, so a
 * move can top up every note changed since. A sweep spans passes, each on a
 * newer census; a note swept early and edited before the wrap is never
 * revisited, so the time is the starting pass's, not the wrapping pass's.
 *
 * In its own file because graphReconcile.test.mjs is near the review
 * threshold.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file plus graphManifest.test.mjs, measured in fix round 1 (the round-0
 * record was off by one: "record now" also failed the no-time test).
 *
 *   record the wall clock (`now`) instead of the census time            6
 *   record the wrapping pass's census time instead of the starting one  4 (spanning, truncated,
 *                                                                         no-time, future cursor)
 *   a truncated pass mid-sweep does not void the recorded time          1 (truncated)
 *   a pass with no census time mid-sweep does not void it               1 (no-time)
 *   maintainNow passes no census time                                   1 (maintainNow)
 *   maintainNow passes the time while search has notes pending          1 (pending)
 *   maintainNow lets the sync stamp listedAt at the end of the pass     1 (mid-pass edit)
 *   wrap publishes a cursor time later than its own census              1 (future cursor)
 *   wrap does not reset sweepCensusAt                                   1 (wrap cursor; the next
 *                                                                         sweep start overwrites it,
 *                                                                         so only the cursor shows it)
 *   graphHealth reports coveredThrough when not complete                1 (graphManifest)
 *   parseManifest accepts any sweepCensusAt                             1 (graphManifest)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphHealth, loadGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey, maintenanceCursorKey } from "../src/graph/keys.js";
import { RESOLVER_VERSION } from "../src/graph/facts.js";
import { readNode } from "../src/graph/project.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { loadIndexManifest } from "../src/search/shards/io.js";
import { memoryBucket } from "./store/fixtures.mjs";

const now = 1_700_000_000_000; // 2023: never equal to any listing time below
const big = () => createSearchBudget(100000);
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();

function bucket() {
  const b = memoryBucket();
  b.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  return b;
}
function censusOf(b) {
  const census = new Map();
  for (const [key, { etag }] of b.objects) if (defaultIsIndexable(key)) census.set(key, etag);
  return census;
}
const pass = (b, budget, listedAt, censusComplete = true) =>
  reconcileGraph(b, budget, { census: censusOf(b), censusComplete, censusListedAt: listedAt, isIndexable: defaultIsIndexable, now });
const health = async (b) => (await loadGraphManifest(b, big()))?.health;
const cursor = (b) => JSON.parse(b.objects.get(maintenanceCursorKey("1"))?.body ?? "{}");

async function seed(b, n) {
  for (let i = 0; i < n; i += 1) await b.put(`n${String(i).padStart(3, "0")}.md`, `[next](./n${String(i + 1).padStart(3, "0")}.md)`);
}

test("a wrapped sweep on a complete census records the census listing time, not the wall clock", async () => {
  const b = bucket();
  await seed(b, 5);
  for (let i = 0; i < 6 && !(await graphHealth(b, big())).complete; i += 1) await pass(b, big(), at(0));
  const h = await graphHealth(b, big());
  assert.equal(h.complete, true);
  assert.equal(h.coveredThrough, at(0));
  assert.equal((await health(b)).sweepCensusAt, at(0));
});

test("a sweep spanning passes records the listing time of the pass that started it", async () => {
  const b = bucket();
  await seed(b, 40);
  await pass(b, big(), at(0)); // converge once, then make every note need a re-read
  for (const [key] of [...b.objects].filter(([k]) => defaultIsIndexable(k))) await b.put(key, `${b.objects.get(key).body} edited`);
  let startedAt = null;
  let spanned = 0;
  for (let i = 1; i < 400; i += 1) {
    const c = cursor(b);
    if (!c.sweepCursor && !c.sweepStartedAt) startedAt = i;
    const out = await pass(b, createSearchBudget(15), at(i));
    if (out.sweepComplete) {
      if (startedAt !== i) spanned += 1;
      assert.equal((await health(b)).sweepCensusAt, at(startedAt), `wrap at pass ${i}`);
    }
    if (spanned >= 2) break;
  }
  assert.ok(spanned >= 2, "at least two sweeps spanned passes");
});

test("a wrap on a truncated census records nothing, and a sweep begun on one records null", async () => {
  const b = bucket();
  await seed(b, 5);
  for (let i = 0; i < 4; i += 1) await pass(b, big(), at(i), false);
  assert.equal((await health(b)).sweepCensusAt, undefined, "an incomplete wrap publishes no health");
  assert.equal((await graphHealth(b, big())).coveredThrough, null);

  // Begun on a truncated census, wrapped on a complete one: covers nothing provable.
  const c = bucket();
  await seed(c, 40);
  await pass(c, big(), at(0));
  for (const [key] of [...c.objects].filter(([k]) => defaultIsIndexable(k))) await c.put(key, `${c.objects.get(key).body} edited`);
  const first = await pass(c, createSearchBudget(15), at(1), false);
  assert.equal(first.sweepComplete, false, "the first pass does not wrap");
  let wrapped = false;
  for (let i = 2; i < 400 && !wrapped; i += 1) wrapped = (await pass(c, createSearchBudget(15), at(i))).sweepComplete;
  assert.ok(wrapped);
  assert.equal((await health(c)).sweepCensusAt, null);
  assert.equal((await graphHealth(c, big())).coveredThrough, null);

  // Begun on a complete census, one truncated pass mid-sweep: also null.
  const d = bucket();
  await seed(d, 40);
  await pass(d, big(), at(0));
  for (const [key] of [...d.objects].filter(([k]) => defaultIsIndexable(k))) await d.put(key, `${d.objects.get(key).body} edited`);
  assert.equal((await pass(d, createSearchBudget(15), at(1))).sweepComplete, false);
  assert.equal(cursor(d).sweepCensusAt, at(1), "started on a complete census");
  assert.equal((await pass(d, createSearchBudget(15), at(2), false)).sweepComplete, false);
  wrapped = false;
  for (let i = 3; i < 400 && !wrapped; i += 1) wrapped = (await pass(d, createSearchBudget(15), at(i))).sweepComplete;
  assert.ok(wrapped);
  assert.equal((await health(d)).sweepCensusAt, null);
});

test("an unparseable census time records null", async () => {
  const b = bucket();
  await seed(b, 3);
  await pass(b, big(), at(0));
  await pass(b, big(), "not a date");
  assert.equal((await health(b)).sweepCensusAt, null);
});

test("maintainNow records the search manifest's freshness.listedAt", async () => {
  const b = bucket();
  await seed(b, 5);
  const deferred = [];
  const store = Object.assign(Object.create(b), { defer: (p) => deferred.push(p) });
  for (let i = 0; i < 6 && !(await graphHealth(b, big())).complete; i += 1) {
    await maintainIndexAfter(store, createSearchBudget(400), defaultIsIndexable, null);
    await Promise.all(deferred.splice(0));
  }
  const listedAt = (await loadIndexManifest(b, big(), 0)).freshness.listedAt;
  assert.equal(typeof listedAt, "string");
  assert.equal((await graphHealth(b, big())).coveredThrough, listedAt);
});

// Fix round 1 (review 1): every source of a too-late time.

const maintained = (b) => {
  const deferred = [];
  const store = Object.assign(Object.create(b), { defer: (p) => deferred.push(p) });
  return async () => {
    await maintainIndexAfter(store, createSearchBudget(400), defaultIsIndexable, null);
    await Promise.all(deferred.splice(0));
  };
};
async function seedMoved(b) {
  await seed(b, 5);
  await b.put("a.md", "[old](./target.md)");
  await b.put("target.md", "t");
}
const aNode = async (b) => (await readNode(b, big(), (await loadGraphManifest(b, big())).generation, "a.md")).old;

test("a note search could not fetch (freshness.pending > 0) never lets coveredThrough pass its edit", async () => {
  const b = bucket();
  await seedMoved(b);
  const run = maintained(b);
  for (let i = 0; i < 8 && !(await graphHealth(b, big())).complete; i += 1) await run();
  await run();
  assert.equal((await graphHealth(b, big())).complete, true, "converged");
  await new Promise((r) => setTimeout(r, 5));
  const editedAt = new Date().toISOString();
  await b.put("a.md", "[new](./elsewhere.md)");
  const currentEtag = b.objects.get("a.md").etag;
  await new Promise((r) => setTimeout(r, 5));
  let fail = 1;
  const realGet = b.get.bind(b);
  b.get = async (k) => {
    if (k === "a.md" && fail > 0) {
      fail -= 1;
      throw new Error("transient");
    }
    return realGet(k);
  };
  for (let i = 0; i < 3; i += 1) {
    fail = 1;
    await run();
  }
  assert.ok((await loadIndexManifest(b, big(), 0)).freshness.pending > 0, "search left a.md pending");
  const h = await graphHealth(b, big());
  const node = await aNode(b);
  assert.ok(!(h.complete && h.coveredThrough > editedAt && node.observedSourceVersion !== currentEtag),
    "coveredThrough is after a.md's edit while its node holds the pre-edit content");
});

test("an edit after the listing but before the pass ends is not behind coveredThrough", async () => {
  const b = bucket();
  const uploadedAt = new Map();
  const realPut = b.put.bind(b);
  b.put = async (k, v, o) => {
    const r = await realPut(k, v, o);
    if (r) uploadedAt.set(k, new Date());
    return r;
  };
  const realList = b.list.bind(b);
  let afterList = null;
  b.list = async (opts) => {
    const out = await realList(opts);
    out.objects = out.objects.map((o) => ({ ...o, etag: b.objects.get(o.key)?.etag, uploaded: uploadedAt.get(o.key) ?? o.uploaded }));
    if (afterList && !(opts?.prefix || "").startsWith(".context")) {
      const f = afterList;
      afterList = null;
      await f();
    }
    return out;
  };
  await seedMoved(b);
  const run = maintained(b);
  for (let i = 0; i < 8 && !(await graphHealth(b, big())).complete; i += 1) await run();
  await run();
  assert.equal((await graphHealth(b, big())).complete, true, "converged");
  let editedAt = null;
  afterList = async () => {
    await b.put("a.md", "[new](./elsewhere.md)");
    editedAt = uploadedAt.get("a.md").toISOString();
    await new Promise((r) => setTimeout(r, 20));
  };
  await run();
  assert.ok(editedAt, "the edit landed mid-pass");
  const h = await graphHealth(b, big());
  const node = await aNode(b);
  assert.ok(!(h.complete && h.coveredThrough > editedAt && node.occurrences[0].target === "./target.md"),
    "a.md was edited before coveredThrough while its node holds the pre-edit references");
});

test("a mid-sweep cursor time later than the wrapping census is never published", async () => {
  const b = bucket();
  await seed(b, 5);
  for (let i = 0; i < 6 && !(await graphHealth(b, big())).complete; i += 1) await pass(b, big(), at(0));
  const cur = cursor(b);
  await b.put(maintenanceCursorKey("1"), JSON.stringify({ ...cur, sweepCursor: "n000.md", sweepStartedAt: "x", sweepCensusAt: "2099-01-01T00:00:00.000Z" }));
  await pass(b, big(), at(0));
  assert.notEqual((await graphHealth(b, big())).coveredThrough, "2099-01-01T00:00:00.000Z");
  assert.equal((await health(b)).sweepCensusAt, null);
});

test("a pass mid-sweep with no census time voids the sweep's time", async () => {
  const b = bucket();
  await seed(b, 40);
  await pass(b, big(), at(0));
  for (const [key] of [...b.objects].filter(([k]) => defaultIsIndexable(k))) await b.put(key, `${b.objects.get(key).body} edited`);
  assert.equal((await pass(b, createSearchBudget(15), at(1))).sweepComplete, false);
  assert.equal(cursor(b).sweepCensusAt, at(1));
  assert.equal((await pass(b, createSearchBudget(15), undefined)).sweepComplete, false);
  assert.equal(cursor(b).sweepCensusAt, "", "a pass without a time voids it");
  let wrapped = false;
  for (let i = 3; i < 400 && !wrapped; i += 1) wrapped = (await pass(b, createSearchBudget(15), at(i))).sweepComplete;
  assert.ok(wrapped);
  assert.equal((await health(b)).sweepCensusAt, null);
});

test("the cursor a wrap leaves names no sweep time", async () => {
  const b = bucket();
  await seed(b, 3);
  const out = await pass(b, big(), at(0));
  assert.equal(out.sweepComplete, true);
  assert.equal((await health(b)).sweepCensusAt, at(0));
  assert.deepEqual([cursor(b).sweepCursor, cursor(b).sweepStartedAt, cursor(b).sweepCensusAt], ["", "", ""]);
});

test("a rebuild cutover publishes the start census of the building generation's own last sweep", async () => {
  const b = bucket();
  await seed(b, 40);
  await pass(b, big(), at(0));
  assert.equal((await health(b)).sweepCensusAt, at(0));
  // An older resolver on the manifest: the next pass starts building generation 2.
  const m = JSON.parse(b.objects.get(graphManifestKey()).body);
  await b.put(graphManifestKey(), JSON.stringify({ ...m, resolverVersion: RESOLVER_VERSION - 1 }));
  const building = () => JSON.parse(b.objects.get(maintenanceCursorKey("2"))?.body ?? "{}");
  let startedAt = null;
  for (let i = 1; i < 2000; i += 1) {
    const c = building();
    if (!c.sweepCursor && !c.sweepStartedAt) startedAt = i;
    await pass(b, createSearchBudget(15), at(i));
    if (JSON.parse(b.objects.get(graphManifestKey()).body).generation !== "2") continue;
    assert.notEqual(startedAt, i, "the cutover sweep spanned passes");
    assert.equal((await health(b)).sweepCensusAt, at(startedAt));
    const h = await graphHealth(b, big());
    assert.equal(h.complete, true);
    assert.equal(h.coveredThrough, at(startedAt));
    return;
  }
  assert.fail("no cutover to 2");
});
