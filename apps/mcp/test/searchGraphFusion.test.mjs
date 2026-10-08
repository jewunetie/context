/**
 * Graph-assisted ranking for search, off by default (Task 29, OPEN-67,
 * OPEN-68). `fuseRanks` is pure; the rest runs `searchVisibleNotes` and
 * `retrieveCandidates` over a `memoryBucket()` holding projected graph
 * records and a converged sharded index, so every reason comes from the
 * stores the gateway reads.
 *
 * The off pin: `OFF_DIGEST` was computed by running `offScenario` against the
 * tree before Task 29 (cddbc9f9), with `store.searchGraphBoost` absent. Every
 * store operation (deferred maintenance included, awaited), every stored body
 * with wall-clock stamps masked, and every answer go into it. If it fails on
 * purpose, recompute it from the code before the change, not after it.
 *
 * Invariance. Single-shard fixtures sweep every budget from 0 upward. The
 * multi-shard fixture (over 300 hidden notes) sweeps from the lexical floor
 * upward: below it the answer changes through search_notes' own documented
 * tight-budget routing channel (src/search/visible.js, progress.md owner
 * list), which this task does not touch. At every budget a team caller's
 * answer is either the hidden-free fused answer or the hidden-free lexical
 * answer with `graphIncomplete` (the one documented bit).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   SEARCH_PINNED 0 (lexical top 3 unpinned)                                1 (top three stay in place)
 *   fuseRanks ignoring `pinned`                                            3 (two fuseRanks, top three)
 *   graph degree counted before canSee (neighbors.js shared())             2 (both invariance tests)
 *   a seed's unfinished graph skipped instead of withholding all of it     2 (both invariance tests)
 *   graph candidates not filtered by the visible docmap paths              1 (docmap no longer lists)
 *   graph candidates not filtered by the search prefix                     1 (prefix)
 *   the switch on by default ("b2" for an absent field)                    6 (off pin, b2, top three, label, both invariance)
 *   kill switch ignored by the search path (red before its fix)            1 (kill switch)
 *
 * Fix round 1 (each new test red first against a7e0116d):
 *   move jobs not read by the boosted path (the sentinel-gated list)       1 (fix 1)
 *   linked hits rendered without their label                               1 (fix 2)
 *   count line without "plus M linked"                                     1 (fix 2)
 *   graph candidates under the folder prefix rule                          1 (fix 3)
 *   graph health not handed to each seed (3 manifest reads)                1 (fix 4)
 *   an array accepted as a variant                                         1 (off pin)
 *
 * Not caught on its own: dropping the best-effort check on the graph manifest,
 * because each seed's graphNeighbors answer carries the same health and is
 * checked again (the unavailable-or-best-effort test fails if both go).
 *
 * RED: the file failed to load on the missing src/search/fuse.js.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { fuseRanks } from "../src/search/fuse.js";
import { retrieveCandidates } from "../src/graph/retrieve.js";
import { searchVisibleNotes } from "../src/search/visibleNotes.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { canSee } from "../src/privacy/engine.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { moveJobKey } from "../src/moves/jobs.js";
import { toolSearchNotes } from "../src/tools/search.js";

// Re-pinned for PARSER_VERSION 2 (bare URLs): a dump of { log, answers } under
// versions 1 and 2 differs only in the graph records' parserVersion and the
// referenceSetVersion derived from it; the fixture has no bare URLs.
const OFF_DIGEST = "77e295f5efcfcf7b063aad278bef64a37beb5a611397c31d15044b34fa93e608";
const NOW = Date.parse("2026-01-01T00:00:00Z");
const gen = "1";
const RULES = [{ prefix: "w", vis: "team" }];
const OVERRIDES = new Map();
const indexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));

// ---------------------------------------------------------------- fuseRanks

test("fuseRanks: the pinned lexical hits keep positions 1 to 3 whatever the graph lists say", () => {
  const lexical = ["a.md", "b.md", "c.md", "d.md", "e.md"];
  const hub = ["z.md", "e.md", "d.md", "c.md", "b.md", "a.md"];
  const out = fuseRanks(lexical, [hub, hub, hub, hub, hub], { pinned: 3, k: 60, weight: 0.5 });
  assert.deepEqual(out.slice(0, 3), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(new Set(out), new Set([...lexical, "z.md"]));
});

test("fuseRanks: a graph-only candidate can enter only below the pinned hits", () => {
  const out = fuseRanks(["a.md", "b.md"], [["g.md"], ["g.md"], ["g.md"]], { pinned: 3, k: 60, weight: 0.5 });
  assert.deepEqual(out, ["a.md", "b.md", "g.md"]);
  // Below the pins a strongly supported candidate can pass a weak lexical one.
  const lexical = ["a.md", "b.md", "c.md", "d.md"];
  const tail = fuseRanks(lexical, [["g.md"], ["g.md"], ["g.md"]], { pinned: 3, k: 60, weight: 0.5 });
  assert.deepEqual(tail, ["a.md", "b.md", "c.md", "g.md", "d.md"]);
  // With one list it cannot (0.5 / 61 < 1 / 64).
  assert.deepEqual(fuseRanks(lexical, [["g.md"]], { pinned: 3, k: 60, weight: 0.5 }), [...lexical, "g.md"]);
});

test("fuseRanks: equal scores break by path, deterministically; empty graph lists give the lexical order", () => {
  assert.deepEqual(fuseRanks(["a.md"], [["y.md"], ["x.md"]], { pinned: 3, k: 60, weight: 0.5 }), ["a.md", "x.md", "y.md"]);
  assert.deepEqual(fuseRanks(["a.md"], [["x.md"], ["y.md"]], { pinned: 3, k: 60, weight: 0.5 }), ["a.md", "x.md", "y.md"]);
  const lexical = ["q.md", "p.md", "o.md", "n.md", "m.md"];
  assert.deepEqual(fuseRanks(lexical, [], { pinned: 3, k: 60, weight: 0.5 }), lexical);
  assert.deepEqual(fuseRanks(lexical, [[], []], { pinned: 0, k: 60, weight: 0.5 }), lexical);
  // A list repeating a candidate counts its first rank only.
  assert.deepEqual(fuseRanks([], [["b.md", "a.md", "b.md"]], { pinned: 3, k: 60, weight: 0.5 }), ["b.md", "a.md"]);
});

// ---------------------------------------------------------------- fixtures

/** A bucket holding `notes`, their graph projections (unless `graph` is false) and a converged index. */
async function world(notes, { ready = true, graph = true } = {}) {
  const store = memoryBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (const [path, body] of Object.entries(notes)) await store.put(path, body);
  if (graph) {
    await initGraphManifest(store, createSearchBudget(100000), { mode: "conditional", now: NOW });
    for (const [path, body] of Object.entries(notes)) {
      const { state } = await projectNote(store, path, body, "1", { budget: createSearchBudget(100000), gen, mode: "conditional", now: NOW });
      assert.equal(state, "projected", path);
    }
    if (ready) {
      const m = JSON.parse(store.objects.get(graphManifestKey()).body);
      await store.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "ready", sweepComplete: true } }));
    }
  }
  for (let pass = 0; pass < 60; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable, now: NOW });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  return store;
}

/**
 * `searchVisibleNotes` on a per-call view of `store` (the gateway builds a
 * fresh store per request), with deferred maintenance awaited and nothing
 * written back: each call sees the same bucket.
 */
async function search(store, query, { boost, scope = "workspace", budget, prefix = "" } = {}) {
  const snapshot = new Map([...store.objects].map(([k, v]) => [k, { ...v }]));
  const deferred = [];
  const view = Object.create(store);
  if (boost !== undefined) view.searchGraphBoost = boost;
  if (budget !== undefined) view.searchSubrequestBudget = budget;
  view.defer = (p) => deferred.push(p);
  try {
    return await searchVisibleNotes(view, scope, RULES, OVERRIDES, query, prefix);
  } finally {
    await Promise.allSettled(deferred);
    store.objects.clear();
    for (const [k, v] of snapshot) store.objects.set(k, v);
  }
}
const keys = (found) => found.hits.map((h) => h.key);

const BASE = {
  "w/a/kestrel.md": "# Kestrel plan\n\nThe kestrel cluster moves. See [[w/b/harbor]] and [ref](https://example.com/shared).\n",
  "w/b/harbor.md": "# Harbor\n\nRegion notes with no query word.\n",
  "w/c/other.md": "# Other\n\nAlso cites [[w/b/harbor]] here.\n",
  "w/c/urlmate.md": "# Url mate\n\nReads [x](https://example.com/shared).\n",
  "w/d/kestrel2.md": "# Second\n\nA kestrel footnote.\n",
  "w/e/far.md": "# Far\n\nNothing related.\n",
};

// ---------------------------------------------------------------- off pin

/** Records every op with stored bodies' wall-clock stamps masked. */
function recording(store, log) {
  const mask = (v) => (typeof v === "string" ? v.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "T").replace(/"([A-Za-z]+)":1[78]\d{11}/g, '"$1":0') : v);
  const { get, put, list } = store;
  return Object.assign(store, {
    async get(key) {
      log.push(["get", key]);
      return get.call(store, key);
    },
    async put(key, value, options) {
      log.push(["put", key, options ?? null, mask(typeof value === "string" ? value : new TextDecoder().decode(value))]);
      return put.call(store, key, value, options);
    },
    async list(options) {
      log.push(["list", options ?? null]);
      const listed = await list.call(store, options);
      for (const object of listed.objects ?? []) object.uploaded = new Date(NOW);
      return listed;
    },
  });
}

async function offScenario(boost) {
  // Maintenance behind the answer stamps and compares Date.now (pass start,
  // graph observedAt); frozen an hour after the fixture's index time, the
  // order of every op is fixed (12 of 12 runs one digest).
  const realNow = Date.now;
  Date.now = () => NOW + 3_600_000;
  try {
    return await offRun(boost);
  } finally {
    Date.now = realNow;
  }
}

async function offRun(boost) {
  const log = [];
  const store = recording(await world(BASE), log);
  log.length = 0;
  const answers = [];
  for (const [query, scope, budget, prefix] of [
    ["kestrel", "workspace", undefined, ""],
    ["kestrel", "private", undefined, ""],
    ["harbor region", "workspace", undefined, ""],
    ["kestrel", "workspace", 12, ""],
    ["kestrel", "workspace", undefined, "w/a"],
    ["nothingmatches", "workspace", undefined, ""],
  ]) {
    answers.push(await search(store, query, { boost, scope, budget, prefix }));
  }
  return createHash("sha256").update(JSON.stringify({ log, answers })).digest("hex");
}

test("off: absent, \"off\" and an unknown value all reproduce the pre-Task-29 store ops and answers byte for byte", async () => {
  const digest = await offScenario(undefined);
  assert.equal(await offScenario(undefined), digest, "the scenario is deterministic");
  assert.equal(digest, OFF_DIGEST);
  assert.equal(await offScenario("off"), OFF_DIGEST);
  assert.equal(await offScenario("B2"), OFF_DIGEST);
  // Fix round 1: only a string names a variant; an array would coerce to one.
  assert.equal(await offScenario(["b2"]), OFF_DIGEST);
});

// ---------------------------------------------------------------- switch on

test("b2: a note linked from the top lexical hit but lacking the query term comes back, and not with off", async () => {
  const store = await world(BASE);
  const off = await search(store, "kestrel");
  assert.deepEqual(keys(off), ["w/a/kestrel.md", "w/d/kestrel2.md"]);
  assert.equal(off.graphIncomplete, undefined);
  const b2 = await search(store, "kestrel", { boost: "b2" });
  // Pinned lexical hits, then the link and the shared target, tied and broken by path.
  assert.deepEqual(keys(b2), ["w/a/kestrel.md", "w/d/kestrel2.md", "w/b/harbor.md", "w/c/other.md"]);
  assert.deepEqual(b2.hits.slice(0, 2), off.hits);
  // A graph-only hit is named by its file, from no body read.
  assert.deepEqual(b2.hits[2], { key: "w/b/harbor.md", title: "harbor", snippets: [], linked: true });
  assert.equal(b2.graphIncomplete, false);
  assert.equal(b2.matchCount, off.matchCount);
  // b3 adds the shared URL; b4 adds no candidate of its own.
  const b3 = await search(store, "kestrel", { boost: "b3" });
  assert.deepEqual(keys(b3), [...keys(b2), "w/c/urlmate.md"]);
  const b4 = await search(store, "kestrel", { boost: "b4" });
  assert.deepEqual(new Set(keys(b4)), new Set(keys(b3)));
  // The owner gets the same graph candidates.
  assert.deepEqual(keys(await search(store, "kestrel", { boost: "b2", scope: "private" })), keys(b2));
});

test("b2: the top three lexical hits stay in place even when a graph candidate outscores them", async () => {
  const notes = {
    "w/x/alpha.md": "# Zebra\n\nzebra zebra zebra, see [[w/x/gamma]].\n",
    "w/x/gamma.md": "# Gamma\n\nBack to [[w/x/alpha]].\n",
    "w/y/beta.md": "# Beta\n\nOne zebra.\n",
    "w/z/delta.md": "# Delta\n\nAnother zebra here.\n",
  };
  const store = await world(notes);
  const off = keys(await search(store, "zebra"));
  assert.equal(off.length, 3);
  // gamma is both linked from and linking to the top hit: 2 x 0.5 / 61 beats 1 / 62.
  assert.deepEqual(keys(await search(store, "zebra", { boost: "b2" })), [...off, "w/x/gamma.md"]);
});

test("b2 with a prefix: a graph neighbour outside the prefix is not returned", async () => {
  const store = await world(BASE);
  const found = await search(store, "kestrel", { boost: "b2", prefix: "w/a" });
  assert.deepEqual(keys(found), ["w/a/kestrel.md"]);
});

test("an unavailable or best-effort graph returns the lexical answer unchanged, labelled", async () => {
  for (const options of [{ graph: false }, { ready: false }]) {
    const store = await world(BASE, options);
    const off = await search(store, "kestrel");
    for (const boost of ["b2", "b3", "b4"]) {
      assert.deepEqual(await search(store, "kestrel", { boost }), { ...off, graphIncomplete: true }, `${JSON.stringify(options)} ${boost}`);
    }
  }
});

test("the graph kill switch (WRITE_ENRICH_SUBREQUEST_BUDGET 0) withholds the graph from search too", async () => {
  const store = await world(BASE);
  const off = await search(store, "kestrel");
  store.writeEnrichBudget = 0;
  assert.deepEqual(await search(store, "kestrel", { boost: "b2" }), { ...off, graphIncomplete: true });
});

test("search_notes renders the label only when the graph was withheld", async () => {
  const { toolSearchNotes } = await import("../src/tools/search.js");
  const text = async (store, boost) => {
    const view = Object.create(store);
    if (boost) view.searchGraphBoost = boost;
    view.defer = () => {};
    return (await toolSearchNotes(view, "workspace", RULES, OVERRIDES, "kestrel")).content[0].text;
  };
  const LABEL = /link-based ranking was unavailable/;
  assert.doesNotMatch(await text(await world(BASE, { graph: false })), LABEL);
  assert.match(await text(await world(BASE, { graph: false }), "b2"), LABEL);
  assert.doesNotMatch(await text(await world(BASE), "b2"), LABEL);
});

// ---------------------------------------------------------------- privacy and budget

// The seed also links a private target, which a visible note cites too.
const INV = {
  ...BASE,
  "w/a/kestrel.md": `${BASE["w/a/kestrel.md"]}Also [[private/secret]].\n`,
  "w/c/cosecret.md": "# Co secret\n\nCites [[private/secret]].\n",
  // The second seed contributes too, so a partial graph answer differs from a whole one.
  "w/d/kestrel2.md": "# Second\n\nA kestrel footnote, see [[w/e/far]].\n",
};
const many = (n, body) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/h${i}.md`, body(i)]));
const VARIANTS = {
  "hidden note linking the seed": { "private/back.md": "# Back\n\n[[w/a/kestrel]]\n" },
  "hidden shared target exists": { "private/secret.md": "# Secret\n\nplain\n" },
  "hidden co-citers past the hub cap": many(60, () => "[[w/b/harbor]]\n"),
  "hidden shared URL citers past the hub cap": many(60, () => "[u](https://example.com/shared)\n"),
  // More than one posting page (256 entries) before the second seed is read.
  "hidden backlinks past one posting page": many(260, () => "[[w/a/kestrel]]\n"),
};

/** Each budget's answer is the hidden-free fused one or the hidden-free lexical one, labelled; both occur. */
async function assertInvariant(base, variant, budgets, boost = "b3") {
  const seen = { fused: 0, withheld: 0 };
  for (const budget of budgets) {
    const fused = await search(base, "kestrel", { boost, budget });
    const lexical = { ...(await search(base, "kestrel", { budget })), graphIncomplete: true };
    const got = await search(variant, "kestrel", { boost, budget });
    if (isDeepEqual(got, fused) && got.graphIncomplete === false) seen.fused += 1;
    else if (isDeepEqual(got, lexical)) seen.withheld += 1;
    else assert.deepEqual(got, fused, `budget ${budget}`);
  }
  // Positive control: the sweep crosses the graph's own budget boundary.
  assert.ok(seen.fused > 0 && seen.withheld > 0, JSON.stringify(seen));
}
const isDeepEqual = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

test("privacy: hidden notes leave a team caller's answer equal at every budget, tight and generous", async () => {
  const base = await world(INV);
  // Positive control: the generous answer is fused and complete.
  const generous = await search(base, "kestrel", { boost: "b3" });
  assert.equal(generous.graphIncomplete, false);
  assert.ok(keys(generous).includes("w/b/harbor.md"));
  assert.ok(keys(generous).includes("w/e/far.md"), "the second seed's link");
  assert.ok(!keys(generous).includes("w/c/cosecret.md"), "a hidden target connects nothing");
  const budgets = Array.from({ length: 81 }, (_, i) => i);
  for (const [name, extra] of Object.entries(VARIANTS)) {
    const variant = await world({ ...INV, ...extra });
    await assertInvariant(base, variant, budgets);
    assert.deepEqual(await search(variant, "kestrel", { boost: "b3" }), generous, name);
  }
});

test("privacy: a multi-shard index (over 300 hidden notes) leaves the answer equal from the lexical floor up", async () => {
  const base = await world(INV);
  const variant = await world({ ...INV, ...many(320, (i) => `# Hidden ${i}\n\nfiller words number${i} [[w/a/kestrel]] [[w/b/harbor]]\n`) });
  // The lexical floor: below it search_notes' own routing channel decides.
  // The floor is one past the last budget (of 0 to 150) where the off answers differ.
  let floor = 0;
  for (let b = 0; b <= 150; b += 1) {
    if (!isDeepEqual(await search(variant, "kestrel", { budget: b }), await search(base, "kestrel", { budget: b }))) floor = b + 1;
  }
  assert.ok(floor > 0 && floor < 60, `lexical floor ${floor}`);
  await assertInvariant(base, variant, Array.from({ length: 151 - floor }, (_, i) => floor + i));
  assert.deepEqual(await search(variant, "kestrel", { boost: "b3" }), await search(base, "kestrel", { boost: "b3" }));
});

test("budget: retrieval for search never spends more than its budget", async () => {
  const store = await world({ ...INV, ...VARIANTS["hidden co-citers past the hub cap"] });
  const canSeeKey = (k) => canSee(k, "workspace", RULES, OVERRIDES);
  for (let b = 0; b <= 60; b += 1) {
    const budget = createSearchBudget(b);
    await retrieveCandidates(store, { seed: { query: "kestrel" }, intent: "search", variant: "b4", scope: "workspace", moveJobs: [], search: { isVisible: canSeeKey, isIndexable: indexable, query: "kestrel", prefix: "", budget, refreshOnMiss: true } });
    assert.ok(budget.spent <= b, `spent ${budget.spent} of ${b}`);
  }
});

test("b2: a graph candidate the index's docmap no longer lists is not returned (postings outlive a delete)", async () => {
  const store = await world({ ...BASE, "w/f/gone.md": "# Gone\n\nPoints at [[w/a/kestrel]].\n" });
  assert.ok(keys(await search(store, "kestrel", { boost: "b2" })).includes("w/f/gone.md"), "positive control");
  store.objects.delete("w/f/gone.md");
  for (let pass = 0; pass < 10; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable, now: NOW + 120_000 });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  assert.ok(!keys(await search(store, "kestrel", { boost: "b2" })).includes("w/f/gone.md"));
});

// ---------------------------------------------------------------- fix round 1

test("fix 1: a move job with no sentinel withholds the graph; a note moving into a private folder is never a linked hit", async () => {
  // It shares the seed's target and has no query word: a graph-only candidate.
  const store = await world({ ...BASE, "w/mv/a.md": "# Moving\n\nmoving secret [[w/b/harbor]]\n" });
  assert.ok(keys(await search(store, "kestrel", { boost: "b2" })).includes("w/mv/a.md"), "positive control: a linked hit before the move");
  assert.ok(!keys(await search(store, "kestrel")).includes("w/mv/a.md"), "positive control: not a text hit");
  const job = { version: 1, id: "job-0000000000001", source: "w/mv", destination: "private/mv", status: "logical_active", created_at: "2026-01-01", objects: [{ source: "w/mv/a.md", destination: "private/mv/a.md" }] };
  await store.put(moveJobKey(job.id), JSON.stringify(job));
  const off = await search(store, "kestrel");
  const on = await search(store, "kestrel", { boost: "b2" });
  assert.ok(!keys(on).includes("w/mv/a.md"));
  assert.deepEqual(on, { ...off, graphIncomplete: true });
});

test("fix 2: a linked hit says so, the count line says how many, and off renders as before", async () => {
  const store = await world(BASE);
  const text = async (boost) => {
    const view = Object.create(store);
    if (boost) view.searchGraphBoost = boost;
    view.defer = () => {};
    return (await toolSearchNotes(view, "workspace", RULES, OVERRIDES, "kestrel")).content[0].text;
  };
  const off = await text();
  assert.ok(off.startsWith("2 matching notes\n\nw/a/kestrel.md\n"), off);
  assert.doesNotMatch(off, /linked/);
  const on = await text("b2");
  assert.ok(on.startsWith("2 matching notes, plus 2 linked\n\nw/a/kestrel.md\n"), on);
  assert.match(on, /\n\nw\/b\/harbor\.md\n {4}\(linked from a result\)/);
  assert.match(on, /\n\nw\/c\/other\.md\n {4}\(linked from a result\)/);
});

test("fix 3: graph candidates use search's own prefix rule (a string prefix, not a folder)", async () => {
  const store = await world(BASE);
  const whole = keys(await search(store, "kestrel", { boost: "b2" }));
  assert.deepEqual(keys(await search(store, "kestrel", { boost: "b2", prefix: "w/" })), whole);
  assert.deepEqual(keys(await search(store, "kestrel", { boost: "b2", prefix: "w/a/kes" })), ["w/a/kestrel.md"]);
});

test("fix 4: one graph manifest read per boosted search, whatever the number of seeds", async () => {
  const store = await world(BASE);
  let reads = 0;
  const view = Object.create(store);
  view.get = async (key) => {
    if (key === graphManifestKey()) reads += 1;
    return store.get(key);
  };
  const canSeeKey = (k) => canSee(k, "workspace", RULES, OVERRIDES);
  const found = await retrieveCandidates(view, { seed: { query: "kestrel" }, intent: "search", variant: "b3", scope: "workspace", search: { isVisible: canSeeKey, isIndexable: indexable, query: "kestrel", prefix: "", budget: createSearchBudget(600), refreshOnMiss: true } });
  assert.equal(found.graphIncomplete, false);
  assert.ok(keys(found).includes("w/b/harbor.md"), "positive control: two seeds, graph used");
  assert.equal(reads, 1);
});
