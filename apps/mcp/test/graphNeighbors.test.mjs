/**
 * Graph neighbourhood of one note for one caller (`src/graph/neighbors.js`,
 * Task 15). Fixtures project every note with `projectNote` on `memoryBucket()`
 * and build the caller's catalog from the paths `canSeeKey` admits, as the
 * retrieval core's caller does.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   degree counted before canSee (canSee: () => true, filter after)       1 (invariance: "a hidden note citing the seed's target")
 *   bare uniqueness check dropped                                         2 (both ambiguous-name tests)
 *   OPEN-27 family drop off for team callers                              1
 *   encrypted-seed check dropped                                          1
 *   hub cap dropped                                                       1
 *   canSee dropped from every posting read                                1 (invariance)
 *   graph reads on the shared store instead of graphView                  1
 *   definition URLs expanded like inline ones                             1
 *
 * Fix round 1 (each new or changed test red first against f1679583):
 *   per-family drop instead of all-or-nothing                             2 (incomplete chain, one bit)
 *   graph maps in chain order, not path order                             1 (result order)
 *   health left out of the answer                                         2 (health, one bit)
 *   no canSeeKey(path) guard on the seed                                  1
 *   limits.expand taken as given                                          1
 *   shared loop walks on after the budget is gone                         1
 *   "Private", true or undefined scope treated as the owner               1 (incomplete chain)
 *   seed guard outside a catch (fix round 2)                              1 (throwing canSeeKey)
 *
 * RED: the file failed to load on the missing module before neighbors.js existed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphNeighbors, HUB_DEGREE_CAP, MAX_EXPANDED } from "../src/graph/neighbors.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote, removeNote } from "../src/graph/project.js";
import { indexByName } from "../src/links.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

const gen = "1";
const now = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const team = (p) => !p.startsWith("private/");
const owner = () => true;
const SEED = "notes/seed.md";
const ENCRYPTED = "---\ncontext_encryption: v1\n---\nciphertext";

async function world(notes) {
  const store = memoryBucket();
  await initGraphManifest(store, big(), { mode: "conditional", now });
  for (const [path, body] of Object.entries(notes)) {
    const { state } = await projectNote(store, path, body, "1", { budget: big(), gen, mode: "conditional", now });
    assert.equal(state, "projected", path);
  }
  return store;
}

/** The neighbourhood of `seed` as a caller who sees `canSeeKey` would get it. */
async function neighbours(notes, options = {}) {
  const { seed = SEED, canSeeKey = team, paths = true, budget = big(), store, limits } = options;
  // An explicit `scope: undefined` is passed through as given.
  const scope = Object.hasOwn(options, "scope") ? options.scope : canSeeKey === owner ? "private" : "workspace";
  const s = store ?? (await world(notes));
  const visible = Object.keys(notes).filter(canSeeKey);
  const catalog = { byName: indexByName(visible), ...(paths && { paths: new Set(visible) }) };
  return graphNeighbors(s, budget, { path: seed, body: notes[seed], catalog, canSeeKey, scope, limits });
}

/** The whole answer as text, Maps as arrays in their own order: two answers are the same only when this is. */
const ser = (r) => JSON.stringify({
  incoming: [...r.incoming], outgoing: [...r.outgoing], sharedTargets: [...r.sharedTargets], sharedUrls: [...r.sharedUrls],
  unresolved: r.unresolved, complete: r.complete, health: r.health,
});
const hidden = (n, body, prefix = "h") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/${prefix}${i}.md`, body]));

const plain = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

test("backlinks come from an exact link and from a bare name unique in the caller's view", async () => {
  const r = await neighbours({
    [SEED]: "seed text",
    "notes/exact.md": "see [s](./seed.md)",
    "other/bare.md": "see [[seed]]",
    "other/both.md": "[[seed]] and [[notes/seed]]",
    "other/none.md": "nothing here",
  });
  assert.deepEqual(plain(r.incoming), {
    "notes/exact.md": { exact: true, bare: false },
    "other/bare.md": { exact: false, bare: true },
    "other/both.md": { exact: true, bare: true },
  });
  assert.equal(r.complete, true);
});

test("a bare name ambiguous in the caller's view is not a backlink", async () => {
  const notes = {
    [SEED]: "seed text",
    "other/seed.md": "a second seed",
    "notes/exact.md": "[[notes/seed]]",
    "other/bare.md": "see [[seed]]",
  };
  const r = await neighbours(notes);
  assert.deepEqual(plain(r.incoming), { "notes/exact.md": { exact: true, bare: false } });
});

test("a bare name ambiguous only because of a private duplicate is a backlink for a team caller", async () => {
  const notes = { [SEED]: "seed text", "private/seed.md": "hidden twin", "other/bare.md": "see [[seed]]" };
  const store = await world(notes);
  const forTeam = await neighbours(notes, { store });
  assert.deepEqual(plain(forTeam.incoming), { "other/bare.md": { exact: false, bare: true } });
  // The owner sees both notes named "seed", so the name binds to neither.
  const forOwner = await neighbours(notes, { store, canSeeKey: owner });
  assert.deepEqual(plain(forOwner.incoming), {});
});

test("outgoing links and unresolved references come from the body in the request", async () => {
  const body = "[[t/target]] [[t/target|again]] [up](../../out.md) [[gone/away]]\n[d]: ./x.md\n";
  const notes = { [SEED]: body, "t/target.md": "target" };
  const r = await neighbours(notes);
  assert.deepEqual(plain(r.outgoing), { "t/target.md": { occurrences: 2 } });
  const at = (target) => body.indexOf(target);
  assert.deepEqual(r.unresolved, [
    { target: "../../out.md", start: at("../../out.md"), end: at("../../out.md") + 12, state: "invalid" },
    { target: "gone/away", start: at("gone/away"), end: at("gone/away") + 9, state: "missing" },
    { target: "./x.md", start: at("./x.md"), end: at("./x.md") + 6, state: "unsupported" },
  ]);
});

test("a missing target is missing with catalog.paths and unknown without", async () => {
  const notes = { [SEED]: "[[gone/away]]" };
  const store = await world(notes);
  assert.equal((await neighbours(notes, { store })).unresolved[0].state, "missing");
  assert.equal((await neighbours(notes, { store, paths: false })).unresolved[0].state, "unknown");
});

test("shared targets and shared URLs score 1 / log2(2 + visible degree)", async () => {
  const r = await neighbours({
    [SEED]: "[[t/target]] [p](https://example.com/page)",
    "t/target.md": "target",
    "notes/cotarget.md": "also [[t/target]]",
    "notes/courl.md": "read [p](https://example.com/page)",
    "notes/both.md": "[[t/target]] [p](https://example.com/page)",
  });
  // target: seed, cotarget, both (d = 3); url: seed, courl, both (d = 3).
  const s = 1 / Math.log2(5);
  assert.deepEqual(plain(r.sharedTargets), { "notes/both.md": s, "notes/cotarget.md": s });
  assert.deepEqual(plain(r.sharedUrls), { "notes/both.md": s, "notes/courl.md": s });
  assert.equal(r.complete, true);
});

test("privacy invariance: hidden notes, links and citations leave a team caller's answer unchanged", async () => {
  const base = {
    [SEED]: "[[t/target]] [p](https://example.com/page)",
    "t/target.md": "target [[notes/seed]]",
    "notes/cotarget.md": "also [[t/target]]",
    "notes/courl.md": "read [p](https://example.com/page)",
    "notes/backlink.md": "[[seed]]",
  };
  const expected = await neighbours(base);
  assert.equal(expected.complete, true);
  assert.ok(expected.incoming.size > 0 && expected.sharedTargets.size > 0 && expected.sharedUrls.size > 0);
  const variants = {
    "a hidden note": { "private/plain.md": "nothing" },
    "a hidden link to the seed": { "private/link.md": "[x](../notes/seed.md)" },
    "a hidden bare link to the seed": { "private/bare.md": "[[seed]]" },
    "a hidden note citing the seed's target": { "private/cite.md": "[[t/target]]" },
    "a hidden note citing the seed's URL": { "private/url.md": "[p](https://example.com/page)" },
    "a hidden duplicate of the seed's name": { "private/seed.md": "twin" },
  };
  for (const [name, extra] of Object.entries(variants)) {
    assert.equal(ser(await neighbours({ ...base, ...extra })), ser(expected), name);
  }
});

test("a target cited by 60 visible notes is not expanded", async () => {
  const notes = { [SEED]: "[[t/hub]] [[t/small]]", "t/hub.md": "hub", "t/small.md": "small", "notes/peer.md": "[[t/small]]" };
  for (let i = 0; i < 60; i += 1) notes[`cite/c${i}.md`] = "[[t/hub]]";
  const r = await neighbours(notes);
  assert.ok(60 > HUB_DEGREE_CAP);
  assert.deepEqual(plain(r.outgoing), { "t/hub.md": { occurrences: 1 }, "t/small.md": { occurrences: 1 } });
  assert.deepEqual(plain(r.sharedTargets), { "notes/peer.md": 1 / Math.log2(4) });
  assert.equal(r.complete, true);
});

test("expansion stops at limits.expand targets, in document order", async () => {
  const notes = { [SEED]: "[[t/a]] [[t/b]]", "t/a.md": "", "t/b.md": "", "n/x.md": "[[t/a]]", "n/y.md": "[[t/b]]" };
  const r = await neighbours(notes, { limits: { expand: 1 } });
  assert.deepEqual([...r.sharedTargets.keys()], ["n/x.md"]);
  assert.ok(MAX_EXPANDED >= 2);
  assert.deepEqual([...(await neighbours(notes)).sharedTargets.keys()].sort(), ["n/x.md", "n/y.md"]);
});

test("an encrypted seed returns incoming only", async () => {
  const notes = { [SEED]: `${ENCRYPTED}\n[[t/target]] [p](https://example.com/page) [[gone]]`, "t/target.md": "", "n/x.md": "[[t/target]] [[notes/seed]]" };
  const r = await neighbours(notes);
  assert.deepEqual(plain(r.incoming), { "n/x.md": { exact: true, bare: false } });
  assert.equal(r.outgoing.size, 0);
  assert.equal(r.sharedTargets.size, 0);
  assert.equal(r.sharedUrls.size, 0);
  assert.deepEqual(r.unresolved, []);
});

test("an unavailable graph leaves graph parts empty and complete false; the body's own links still resolve", async () => {
  const notes = { [SEED]: "[[t/target]]", "t/target.md": "" };
  const r = await neighbours(notes, { store: memoryBucket() });
  assert.deepEqual(plain(r.outgoing), { "t/target.md": { occurrences: 1 } });
  assert.equal(r.incoming.size + r.sharedTargets.size + r.sharedUrls.size, 0);
  assert.equal(r.complete, false);
});

test("an incomplete chain empties every graph family for a team caller and keeps partial lists for the owner", async () => {
  const notes = { [SEED]: "seed" };
  for (let i = 0; i < 5; i += 1) notes[`n/s${i}.md`] = "[[notes/seed]]";
  const store = await world(notes);
  // Manifest 1, incoming head 1, three of the five validations.
  const forTeam = await neighbours(notes, { store, budget: createSearchBudget(5) });
  assert.equal(forTeam.incoming.size, 0);
  assert.equal(forTeam.complete, false);
  const forOwner = await neighbours(notes, { store, canSeeKey: owner, budget: createSearchBudget(5) });
  assert.equal(forOwner.incoming.size, 3);
  assert.equal(forOwner.complete, false);

  // Incoming finishes; the shared-target chain does not. Manifest, incoming
  // head, one validation, bare head, target head, one of three validations.
  const later = { [SEED]: "[[t/target]]", "t/target.md": "", "n/back.md": "[[notes/seed]]", "n/c0.md": "[[t/target]]", "n/c1.md": "[[t/target]]", "n/c2.md": "[[t/target]]" };
  const s2 = await world(later);
  const team6 = await neighbours(later, { store: s2, budget: createSearchBudget(6) });
  assert.deepEqual([team6.incoming.size, team6.sharedTargets.size, team6.sharedUrls.size, team6.complete], [0, 0, 0, false]);
  const owner6 = await neighbours(later, { store: s2, canSeeKey: owner, budget: createSearchBudget(6) });
  assert.deepEqual([owner6.incoming.size, owner6.sharedTargets.size, owner6.complete], [1, 1, false]);
  // Only "private" exactly is the owner; anything else is strict.
  for (const scope of [undefined, "Private", "team", true, {}]) {
    const r = await neighbours(later, { store: s2, canSeeKey: owner, scope, budget: createSearchBudget(6) });
    assert.equal(r.incoming.size + r.sharedTargets.size + r.sharedUrls.size, 0, String(scope));
  }
});

test("never throws: a failing store or an empty budget gives complete false", async () => {
  const notes = { [SEED]: "[[t/target]]", "t/target.md": "" };
  const broken = { get: async () => { throw new Error("boom"); }, put: async () => null };
  assert.equal((await neighbours(notes, { store: broken })).complete, false);
  const empty = await neighbours(notes, { budget: createSearchBudget(0) });
  assert.equal(empty.complete, false);
  assert.deepEqual(plain(empty.outgoing), { "t/target.md": { occurrences: 1 } });
});

test("graph reads go through the caller's own view, never the shared store", async () => {
  const notes = { [SEED]: "[[t/target]]", "t/target.md": "", "n/x.md": "[[t/target]] [[notes/seed]]" };
  const base = await world(notes);
  const calls = { shared: 0, view: 0, charged: false };
  const shared = {
    get: (k) => ((calls.shared += 1), base.get(k)),
    setExtraOperationCharge: () => { throw new Error("charge installed on the shared store"); },
    forkLogicalView: () => ({
      get: (k) => ((calls.view += 1), base.get(k)),
      setExtraOperationCharge: () => { calls.charged = true; },
    }),
  };
  const r = await neighbours(notes, { store: shared });
  assert.deepEqual({ shared: calls.shared, charged: calls.charged, complete: r.complete }, { shared: 0, charged: true, complete: true });
  assert.ok(calls.view > 0);
});

test("a URL in a reference definition is not expanded (definitions are unsupported, arch 7.1)", async () => {
  const r = await neighbours({ [SEED]: "text\n[r]: https://example.com/def\n", "n/x.md": "[x](https://example.com/def)" });
  assert.equal(r.sharedUrls.size, 0);
  assert.deepEqual(r.unresolved, []);
});

test("one bit at most: hidden notes that add a posting page in any family change nothing but the withheld label, at every budget", async () => {
  const base = {
    [SEED]: "[[t/target]] [p](https://example.com/page)",
    "t/target.md": "target",
    "notes/back.md": "[[notes/seed]]",
    "notes/cotarget.md": "[[t/target]]",
    "notes/courl.md": "[p](https://example.com/page)",
  };
  const H = 300; // over POSTING_PAGE_SIZE (256): one more page in the chain
  const variants = {
    "hidden backlinks": hidden(H, "[[notes/seed]]"),
    "hidden bare backlinks": hidden(H, "[[seed]]"),
    "hidden co-citers": hidden(H, "[[t/target]]"),
    "hidden URL citers": hidden(H, "[p](https://example.com/page)"),
  };
  const noneStore = await world(base);
  const stores = {};
  for (const [k, v] of Object.entries(variants)) stores[k] = await world({ ...base, ...v });
  for (let B = 0; B <= 20; B += 1) {
    const plainAnswer = await neighbours(base, { store: noneStore, budget: createSearchBudget(B) });
    const none = ser(plainAnswer);
    const withheld = ser({ ...plainAnswer, incoming: new Map(), sharedTargets: new Map(), sharedUrls: new Map(), complete: false });
    for (const [k, v] of Object.entries(variants)) {
      const out = ser(await neighbours({ ...base, ...v }, { store: stores[k], budget: createSearchBudget(B) }));
      assert.ok(out === none || out === withheld, `B=${B} ${k}: ${out}`);
      if (none === withheld) assert.equal(out, withheld, `B=${B} ${k}`);
      if (B === 20) assert.equal(out, none, k);
    }
    if (B === 20) assert.equal(plainAnswer.complete, true);
  }
});

test("result order does not depend on where hidden entries sat in the chain", async () => {
  const seedNotes = { [SEED]: "seed" };
  const project = async (store, notes) => {
    for (const [path, body] of Object.entries(notes)) await projectNote(store, path, body, "1", { budget: big(), gen, mode: "conditional", now });
  };
  const a = await world(seedNotes);
  await project(a, { "notes/v1.md": "[[notes/seed]]" });
  await project(a, { "notes/v2.md": "[[notes/seed]]" });
  // 256 hidden fill page 0, v1 lands on page 1, a hidden one leaves, v2 lands on page 0.
  const b = await world(seedNotes);
  const hid = hidden(256, "[[notes/seed]]");
  await project(b, hid);
  await project(b, { "notes/v1.md": "[[notes/seed]]" });
  assert.equal((await removeNote(b, "private/h0.md", { budget: big(), gen, mode: "conditional" })).state, "projected");
  await project(b, { "notes/v2.md": "[[notes/seed]]" });
  const visible = { ...seedNotes, "notes/v1.md": "", "notes/v2.md": "" };
  const ra = await neighbours(visible, { store: a });
  const rb = await neighbours({ ...visible, ...hid }, { store: b });
  assert.deepEqual([...ra.incoming.keys()], ["notes/v1.md", "notes/v2.md"]);
  assert.equal(ser(rb), ser(ra));
});

test("the health read is returned with the answer, at no extra read", async () => {
  const notes = { [SEED]: "x", "n/b.md": "[[notes/seed]]" };
  const store = await world(notes);
  const m = JSON.parse(store.objects.get(graphManifestKey()).body);
  const budget = big();
  const r = await neighbours(notes, { store, budget });
  assert.deepEqual([r.health.state, r.health.generation, r.health.complete], ["partial", "1", false]);
  // Manifest, incoming head, one validation, bare head.
  assert.equal(budget.spent, 4);
  const cases = [
    [{ health: { ...m.health, state: "behind" } }, "behind", "1", 1],
    [{ building: { generation: "2", startedAt: "x" } }, "partial", "1", 1],
    [{ health: { ...m.health, state: "unavailable" } }, "unavailable", "1", 0],
    [{ parserVersion: 99 }, "unavailable", null, 0],
  ];
  for (const [patch, state, generation, incoming] of cases) {
    await store.put(graphManifestKey(), JSON.stringify({ ...m, ...patch }));
    const got = await neighbours(notes, { store });
    assert.deepEqual([got.health.state, got.health.generation, got.incoming.size], [state, generation, incoming], JSON.stringify(patch));
  }
  assert.equal((await neighbours(notes, { store: memoryBucket() })).health.state, "unavailable");
});

test("a seed the caller cannot see returns the empty answer with no store op", async () => {
  const notes = { "private/seed.md": "[[t/target]] [[gone]]", "t/target.md": "", "n/x.md": "[[private/seed]]" };
  const base = await world(notes);
  let gets = 0;
  const store = { get: (k) => ((gets += 1), base.get(k)) };
  const budget = big();
  const r = await neighbours(notes, { seed: "private/seed.md", store, budget });
  assert.deepEqual([gets, budget.spent, r.incoming.size, r.outgoing.size, r.sharedTargets.size, r.sharedUrls.size, r.unresolved.length, r.complete, r.health.state],
    [0, 0, 0, 0, 0, 0, 0, false, "unavailable"]);
});

test("limits.expand other than a non-negative integer falls back to the default; 0 expands nothing", async () => {
  const notes = { [SEED]: "[[t/a]] [[t/b]]", "t/a.md": "", "t/b.md": "", "n/x.md": "[[t/a]]", "n/y.md": "[[t/b]]" };
  const store = await world(notes);
  for (const expand of [-1, 1.5, "1", NaN, null]) {
    assert.equal((await neighbours(notes, { store, limits: { expand } })).sharedTargets.size, 2, String(expand));
  }
  assert.equal((await neighbours(notes, { store, limits: { expand: 0 } })).sharedTargets.size, 0);
});

test("the shared loop stops once the budget is gone", async () => {
  const notes = { [SEED]: "[[t/a]] [[t/b]] [[t/c]]", "t/a.md": "", "t/b.md": "", "t/c.md": "" };
  for (let i = 0; i < 40; i += 1) notes[`n/c${i}.md`] = "[[t/a]] [[t/b]] [[t/c]]";
  const store = await world(notes);
  const inner = createSearchBudget(8);
  let takes = 0;
  const budget = { get remaining() { return inner.remaining; }, get spent() { return inner.spent; }, take: (r) => ((takes += 1), inner.take(r)) };
  const r = await neighbours(notes, { store, budget });
  assert.equal(r.complete, false);
  assert.ok(takes <= 8 + 2, `${takes} takes`);
});

test("a canSeeKey that throws on the seed is treated as not visible: the empty answer, no throw", async () => {
  const notes = { [SEED]: "[[t/target]]", "t/target.md": "" };
  const store = await world(notes);
  const canSeeKey = (p) => { if (p === SEED) throw new Error("boom"); return true; };
  const catalog = { byName: indexByName(Object.keys(notes)), paths: new Set(Object.keys(notes)) };
  const r = await graphNeighbors(store, big(), { path: SEED, body: notes[SEED], catalog, canSeeKey, scope: "workspace" });
  assert.deepEqual([r.outgoing.size, r.incoming.size, r.unresolved.length, r.complete, r.health.state], [0, 0, 0, false, "unavailable"]);
});
