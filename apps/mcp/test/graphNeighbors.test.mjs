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
 * RED: the file failed to load on the missing module before neighbors.js existed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphNeighbors, HUB_DEGREE_CAP, MAX_EXPANDED } from "../src/graph/neighbors.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { projectNote } from "../src/graph/project.js";
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
async function neighbours(notes, { seed = SEED, canSeeKey = team, scope = canSeeKey === owner ? "private" : "workspace", paths = true, budget = big(), store, limits } = {}) {
  const s = store ?? (await world(notes));
  const visible = Object.keys(notes).filter(canSeeKey);
  const catalog = { byName: indexByName(visible), ...(paths && { paths: new Set(visible) }) };
  return graphNeighbors(s, budget, { path: seed, body: notes[seed], catalog, canSeeKey, scope, limits });
}

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
    assert.deepStrictEqual(await neighbours({ ...base, ...extra }), expected, name);
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

test("an incomplete chain drops the whole family for a team caller and keeps it partial for the owner", async () => {
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
