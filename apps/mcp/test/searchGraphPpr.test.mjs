/**
 * Personalized PageRank ranking for search (variant "ppr", SEARCH_GRAPH_BOOST),
 * off by default. Runs `searchVisibleNotes` and `pprWalk` over a
 * `memoryBucket()` holding projected graph records and a converged sharded
 * index, as searchGraphFusion.test.mjs does for b2 to b4.
 *
 * Invariance. The walk's scores are compared float for float between a world
 * and the same world plus hidden notes, so a hidden note that changed an
 * out-degree, a hub test, a node cap cut or an order would show. The search
 * answers are compared at tight and generous budgets, single and multi shard:
 * each is the hidden-free fused answer or the hidden-free lexical answer with
 * `graphIncomplete` (the one documented bit).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file (the pure functions are in graphPpr.test.mjs).
 *
 * S1 hub citers expanded (no HUB_DEGREE_CAP test)                         1 (hub)
 * S3 postings read without the visibility filter                          3 (walk privacy, both search invariance)
 * S4 an unfinished walk answers with what it has                          5 (both invariance, move/record, cap, budget)
 * S5 no node cap                                                          1 (node cap)
 * S6 no read cap                                                          1 (read cap)
 * S7 a seed with no node record accepted                                  1 (record)
 * S8 candidates not filtered by the search prefix                         1 (prefix)
 * S10 active move jobs ignored (openGraph)                                2 (here and searchGraphFusion fix 1)
 * S12 fusePpr ignoring `pinned` (graphPpr.test.mjs)                       1
 * S2a catalog listing hidden docmap paths (openGraph)                     2 (here and searchGraphFusion privacy)
 *
 * Not killed, and why: the final `shown.has(path)` and `see(path)` filters on
 * candidates in retrieve.js. Every node of the walk already comes from the
 * visible catalog and `see`-filtered postings, so they are a second guard that
 * nothing can reach (the existing retrieveCandidates merge keeps the same one).
 * The order citers and links are visited in is not asserted: pprScores sorts
 * its nodes, so visit order cannot reach a score.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { retrieveCandidates } from "../src/graph/retrieve.js";
import { PPR_NODE_CAP, PPR_READ_CAP, pprWalk } from "../src/graph/ppr.js";
import { searchVisibleNotes } from "../src/search/visibleNotes.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { indexByName } from "../src/links.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { canSee } from "../src/privacy/engine.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { moveJobKey } from "../src/moves/jobs.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const gen = "1";
const RULES = [{ prefix: "w", vis: "team" }];
const OVERRIDES = new Map();
const indexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));

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


const PPR = "ppr";
const see = (k) => canSee(k, "workspace", RULES, OVERRIDES);

/** Ten kestrel notes (lexical is full), four of which cite one note that has no query word. */
const TEN = Object.fromEntries([
  ...Array.from({ length: 10 }, (_, i) => [`w/k/k${i}.md`, `# Kestrel ${i}\n\nkestrel kestrel notes${i === 0 ? " kestrel kestrel" : ""}${i < 4 ? " see [[w/b/target]]" : ""}.\n`]),
  ["w/b/target.md", "# Target\n\nThe note four kestrel notes cite, with no query word in it.\n"],
  ["w/b/lonely.md", "# Lonely\n\nCited by nobody.\n"],
]);

test("ppr: a note four lexical hits cite enters the top ten when lexical is full; b3 leaves it out", async () => {
  const store = await world(TEN);
  const off = keys(await search(store, "kestrel", { budget: 300 }));
  assert.equal(off.length, 10);
  assert.ok(!off.includes("w/b/target.md"));
  assert.ok(!keys(await search(store, "kestrel", { boost: "b3", budget: 300 })).includes("w/b/target.md"), "positive control: the one-hop boost cannot");
  const found = await search(store, "kestrel", { boost: PPR, budget: 300 });
  assert.equal(found.graphIncomplete, false);
  assert.equal(found.hits.length, 10);
  const at = keys(found).indexOf("w/b/target.md");
  assert.ok(at >= 0 && at < 10, `target at ${at}`);
  assert.deepEqual(found.hits[at], { key: "w/b/target.md", title: "target", snippets: [], linked: true });
  assert.ok(!keys(found).includes("w/b/lonely.md"));
  // The owner and the team caller get the same notes; the call is deterministic.
  assert.deepEqual(keys(await search(store, "kestrel", { boost: PPR, scope: "private", budget: 300 })), keys(found));
  assert.deepEqual(await search(store, "kestrel", { boost: PPR, budget: 300 }), found);
});

test("ppr: lexical hits keep their own hit objects and a graph-only note is named by its file", async () => {
  const store = await world(BASE);
  const off = await search(store, "kestrel");
  const found = await search(store, "kestrel", { boost: PPR });
  for (const hit of off.hits) assert.deepEqual(found.hits.find((h) => h.key === hit.key), hit);
  assert.ok(keys(found).includes("w/b/harbor.md"));
  assert.equal(found.matchCount, off.matchCount);
});

test("ppr: an unavailable or best-effort graph, and the kill switch, return the lexical answer labelled", async () => {
  for (const options of [{ graph: false }, { ready: false }]) {
    const store = await world(BASE, options);
    assert.deepEqual(await search(store, "kestrel", { boost: PPR }), { ...(await search(store, "kestrel")), graphIncomplete: true }, JSON.stringify(options));
  }
  const store = await world(BASE);
  const off = await search(store, "kestrel");
  store.writeEnrichBudget = 0;
  assert.deepEqual(await search(store, "kestrel", { boost: PPR }), { ...off, graphIncomplete: true });
});

test("ppr: an active move withholds the graph; a seed with no node record withholds it", async () => {
  const moving = await world({ ...BASE, "w/mv/a.md": "# Moving\n\nmoving [[w/b/harbor]]\n" });
  const job = { version: 1, id: "job-0000000000001", source: "w/mv", destination: "private/mv", status: "logical_active", created_at: "2026-01-01", objects: [{ source: "w/mv/a.md", destination: "private/mv/a.md" }] };
  await moving.put(moveJobKey(job.id), JSON.stringify(job));
  assert.deepEqual(await search(moving, "kestrel", { boost: PPR }), { ...(await search(moving, "kestrel")), graphIncomplete: true });
  // A kestrel note written after the graph was projected has no record.
  const store = await world(BASE);
  await store.put("w/n/new.md", "# New\n\nkestrel arrives later.\n");
  for (let pass = 0; pass < 20; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable, now: NOW + 120_000 });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  const found = await search(store, "kestrel", { boost: PPR });
  assert.ok(keys(found).includes("w/n/new.md"), "positive control: the new note is a hit");
  assert.equal(found.graphIncomplete, true);
});

test("ppr with a prefix: a neighbour outside the prefix is not returned; the docmap decides what exists", async () => {
  const store = await world({ ...BASE, "w/f/gone.md": "# Gone\n\nPoints at [[w/a/kestrel]].\n" });
  assert.deepEqual(keys(await search(store, "kestrel", { boost: PPR, prefix: "w/a" })), ["w/a/kestrel.md"]);
  assert.ok(keys(await search(store, "kestrel", { boost: PPR })).includes("w/f/gone.md"), "positive control");
  store.objects.delete("w/f/gone.md");
  for (let pass = 0; pass < 10; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable, now: NOW + 120_000 });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  assert.ok(!keys(await search(store, "kestrel", { boost: PPR })).includes("w/f/gone.md"));
});

// ---------------------------------------------------------------- the walk

/** The walk's inputs as the search builds them: the caller's visible catalog, one generation. */
async function walkOf(store, seedPaths, budget = createSearchBudget(5000)) {
  const shown = new Set([...store.objects.keys()].filter((k) => indexable(k) && see(k)));
  const catalog = { byName: indexByName([...shown]), paths: shown, partial: false };
  return pprWalk(store, budget, { gen, seeds: seedPaths.map((path, i) => ({ path, weight: 1 / (i + 1) })), catalog, see });
}

test("walk: a note two links out is reached, and one citing a hub is worth less than one citing a small note", async () => {
  const store = await world({
    "w/a/seed.md": "# Seed\n\n[[w/b/x]]\n",
    "w/b/x.md": "# X\n\nplain\n",
    "w/c/small.md": "# Small\n\n[[w/b/x]]\n",
    "w/c/big.md": `# Big\n\n[[w/b/x]] ${Array.from({ length: 30 }, (_, i) => `[[w/g/g${i}]]`).join(" ")}\n`,
    ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`w/g/g${i}.md`, `# G${i}\n\nleaf\n`])),
  });
  const scores = await walkOf(store, ["w/a/seed.md"]);
  assert.ok(scores.get("w/c/small.md") > 0 && scores.get("w/c/big.md") > 0);
  assert.ok(scores.get("w/c/small.md") > scores.get("w/c/big.md") * 3, `${scores.get("w/c/small.md")} vs ${scores.get("w/c/big.md")}`);
});

test("walk: a hub (over the hub cap of visible citers) is a node but is not expanded", async () => {
  const citers = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`w/h/c${i}.md`, "# C\n\n[[w/b/hubby]]\n"]));
  for (const [n, expanded] of [[5, true], [60, false]]) {
    const store = await world({ "w/a/seed.md": "# Seed\n\n[[w/b/hubby]]\n", "w/b/hubby.md": "# Hubby\n\nplain\n", ...citers(n) });
    const scores = await walkOf(store, ["w/a/seed.md"]);
    assert.ok(scores.get("w/b/hubby.md") > 0, "the hub itself is scored");
    assert.equal(scores.has("w/h/c0.md"), expanded, `${n} citers`);
  }
});

test("walk: unfinished work returns null, never a partial walk, and spends no more than the cap", async () => {
  const store = await world(TEN);
  const seeds = Array.from({ length: 10 }, (_, i) => `w/k/k${i}.md`);
  assert.ok(await walkOf(store, seeds));
  let needed = 0;
  for (let b = 0; b < 400; b += 1) {
    const budget = createSearchBudget(b);
    const scores = await walkOf(store, seeds, budget);
    assert.ok(budget.spent <= Math.min(b, PPR_READ_CAP), `spent ${budget.spent} of ${b}`);
    if (scores) {
      needed = b;
      break;
    }
  }
  assert.ok(needed > 20 && needed < PPR_READ_CAP, `needed ${needed}`);
  assert.equal(await walkOf(store, seeds, createSearchBudget(needed - 1)), null);
});

test("walk: over the node cap the seeds stay and the rest are cut by score, then path", async () => {
  const leaves = Array.from({ length: 80 }, (_, i) => `w/g/g${i}.md`);
  const store = await world({
    "w/a/seed.md": `# Seed\n\n${leaves.map((p) => `[[${p.slice(0, -3)}]]`).join(" ")}\n`,
    ...Object.fromEntries(leaves.map((p, i) => [p, `# G${i}\n\nleaf\n`])),
  });
  const scores = await walkOf(store, ["w/a/seed.md"]);
  assert.equal(scores.size, PPR_NODE_CAP);
  assert.ok(scores.has("w/a/seed.md"));
  assert.deepEqual([...scores.keys()].filter((p) => p !== "w/a/seed.md").sort(), [...leaves].sort().slice(0, PPR_NODE_CAP - 1));
});

test("walk: a neighbourhood that needs more reads than the cap is withheld, whatever the budget", async () => {
  const seeds = Array.from({ length: 10 }, (_, i) => `w/s/s${i}.md`);
  const citers = Object.fromEntries(seeds.flatMap((s, i) => Array.from({ length: 40 }, (_, j) => [`w/c/c${i}-${j}.md`, `# C\n\n[[${s.slice(0, -3)}]]\n`])));
  const store = await world({ ...Object.fromEntries(seeds.map((s) => [s, "# S\n\nseed\n"])), ...citers });
  const budget = createSearchBudget(5000);
  assert.equal(await walkOf(store, seeds, budget), null);
  assert.ok(budget.spent > 0 && budget.spent <= PPR_READ_CAP, `spent ${budget.spent}`);
});

// ---------------------------------------------------------------- privacy

const INV = {
  ...BASE,
  "w/a/kestrel.md": `${BASE["w/a/kestrel.md"]}Also [[private/secret]] and [[private/p0]] [[private/p1]] [[private/p2]] [[private/p3]].\n`,
  "w/c/cosecret.md": "# Co secret\n\nCites [[private/secret]].\n",
  "w/d/kestrel2.md": "# Second\n\nA kestrel footnote, see [[w/e/far]].\n",
  // A visible citer whose out-degree hidden targets would change.
  "w/c/other.md": "# Other\n\nAlso cites [[w/b/harbor]] and [[private/p0]] [[private/p1]] [[private/p2]] [[private/p3]] here.\n",
};
const many = (n, body) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/h${i}.md`, body(i)]));
const VARIANTS = {
  "hidden note linking the seed": { "private/back.md": "# Back\n\n[[w/a/kestrel]]\n" },
  "hidden link targets exist": { "private/secret.md": "# Secret\n\nplain\n", ...Object.fromEntries([0, 1, 2, 3].map((i) => [`private/p${i}.md`, "# P\n\nplain\n"])) },
  "hidden co-citers past the hub cap": many(60, () => "[[w/b/harbor]]\n"),
  "hidden citers of a second-hop note": many(60, () => "[[w/e/far]]\n"),
  "hidden backlinks past one posting page": many(260, () => "[[w/a/kestrel]]\n"),
};

test("walk privacy: hidden notes leave every score identical, float for float", async () => {
  const base = await world(INV);
  const seeds = ["w/a/kestrel.md", "w/d/kestrel2.md"];
  const want = await walkOf(base, seeds);
  assert.ok(want && want.get("w/b/harbor.md") > 0 && want.get("w/e/far.md") > 0, "positive control");
  for (const [name, extra] of Object.entries(VARIANTS)) {
    const got = await walkOf(await world({ ...INV, ...extra }), seeds);
    assert.deepEqual(got, want, name);
  }
});

const isDeepEqual = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

/** Each budget's answer is the hidden-free fused one or the hidden-free lexical one, labelled; both occur. */
async function assertInvariant(base, variant, budgets) {
  const seen = { fused: 0, withheld: 0 };
  for (const budget of budgets) {
    const fused = await search(base, "kestrel", { boost: PPR, budget });
    const lexical = { ...(await search(base, "kestrel", { budget })), graphIncomplete: true };
    const got = await search(variant, "kestrel", { boost: PPR, budget });
    if (isDeepEqual(got, fused) && got.graphIncomplete === false) seen.fused += 1;
    else if (isDeepEqual(got, lexical)) seen.withheld += 1;
    else assert.deepEqual(got, fused, `budget ${budget}`);
  }
  assert.ok(seen.fused > 0 && seen.withheld > 0, JSON.stringify(seen));
}

test("ppr privacy: hidden notes leave a team caller's answer equal at every budget, tight and generous", async () => {
  const base = await world(INV);
  const generous = await search(base, "kestrel", { boost: PPR });
  assert.equal(generous.graphIncomplete, false);
  assert.ok(keys(generous).includes("w/b/harbor.md") && keys(generous).includes("w/e/far.md"));
  assert.ok(!keys(generous).some((k) => k.startsWith("private/")));
  const budgets = Array.from({ length: 140 }, (_, i) => i);
  for (const [name, extra] of Object.entries(VARIANTS)) {
    const variant = await world({ ...INV, ...extra });
    await assertInvariant(base, variant, budgets);
    assert.deepEqual(await search(variant, "kestrel", { boost: PPR }), generous, name);
  }
});

test("ppr privacy: a multi-shard index (over 300 hidden notes) leaves the answer equal from the lexical floor up", async () => {
  const base = await world(INV);
  const variant = await world({ ...INV, ...many(320, (i) => `# Hidden ${i}\n\nfiller words number${i} [[w/a/kestrel]] [[w/b/harbor]]\n`) });
  let floor = 0;
  for (let b = 0; b <= 150; b += 1) {
    if (!isDeepEqual(await search(variant, "kestrel", { budget: b }), await search(base, "kestrel", { budget: b }))) floor = b + 1;
  }
  assert.ok(floor > 0 && floor < 60, `lexical floor ${floor}`);
  await assertInvariant(base, variant, Array.from({ length: 200 - floor }, (_, i) => floor + i));
  assert.deepEqual(await search(variant, "kestrel", { boost: PPR }), await search(base, "kestrel", { boost: PPR }));
});

test("ppr budget: retrieval for search never spends more than its budget", async () => {
  const store = await world({ ...INV, ...VARIANTS["hidden co-citers past the hub cap"] });
  for (let b = 0; b <= 220; b += 1) {
    const budget = createSearchBudget(b);
    await retrieveCandidates(store, { seed: { query: "kestrel" }, intent: "search", variant: PPR, scope: "workspace", moveJobs: [], search: { isVisible: see, isIndexable: indexable, query: "kestrel", prefix: "", budget, refreshOnMiss: true } });
    assert.ok(budget.spent <= b, `spent ${budget.spent} of ${b}`);
  }
});
