/**
 * Personalized PageRank for graph-assisted search (variant "ppr"): the pure
 * parts of src/graph/ppr.js. The store-backed walk and the search integration
 * are in searchGraphPpr.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fusePpr, pprScores } from "../src/graph/ppr.js";

const seeds = (obj) => new Map(Object.entries(obj));
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

test("pprScores: scores sum to one, distance lowers them, and an empty graph keeps the seed mass", () => {
  const out = pprScores({ seeds: seeds({ "a.md": 1 }), edges: [["a.md", "b.md", 1], ["b.md", "c.md", 1]] });
  assert.ok(Math.abs(sum(out) - 1) < 1e-9, String(sum(out)));
  assert.ok(out.get("a.md") > out.get("c.md") && out.get("b.md") > out.get("c.md"), "mass falls off with distance from the seed");
  const alone = pprScores({ seeds: seeds({ "a.md": 2, "b.md": 1 }), edges: [] });
  assert.ok(Math.abs(alone.get("a.md") - 2 / 3) < 1e-9 && Math.abs(alone.get("b.md") - 1 / 3) < 1e-9);
});

test("pprScores: a note reachable from two seeds outscores one reachable from one", () => {
  const out = pprScores({
    seeds: seeds({ "s1.md": 1, "s2.md": 1 }),
    edges: [["s1.md", "both.md", 1], ["s2.md", "both.md", 1], ["s1.md", "one.md", 1]],
  });
  assert.ok(out.get("both.md") > out.get("one.md"));
});

test("pprScores: a link counts for less the more links its source note has", () => {
  // Same shape twice; only the source's out-degree (the edge weight) differs.
  const weight = (outDegree) => 1 / outDegree;
  const out = pprScores({
    seeds: seeds({ "s.md": 1 }),
    edges: [["s.md", "x.md", 1], ["x.md", "few.md", weight(2)], ["x.md", "many.md", weight(200)]],
  });
  assert.ok(out.get("few.md") > out.get("many.md") * 10);
  // A seed linked from a hub: the hub's own edge weight is what is divided.
  const fromHub = pprScores({
    seeds: seeds({ "s.md": 1 }),
    edges: [["hub.md", "s.md", 1 / 200], ["small.md", "s.md", 1 / 2]],
  });
  assert.ok(fromHub.get("small.md") > fromHub.get("hub.md") * 10);
});

test("pprScores: both link directions carry the walk", () => {
  const out = pprScores({ seeds: seeds({ "s.md": 1 }), edges: [["s.md", "out.md", 1], ["in.md", "s.md", 1]] });
  assert.ok(out.get("out.md") > 0 && Math.abs(out.get("out.md") - out.get("in.md")) < 1e-12);
});

test("pprScores: deterministic whatever order the edges and seeds arrive in", () => {
  const edges = [["a.md", "b.md", 0.5], ["b.md", "c.md", 1 / 3], ["c.md", "a.md", 1], ["a.md", "d.md", 0.25], ["d.md", "e.md", 0.1]];
  const one = pprScores({ seeds: seeds({ "a.md": 1, "c.md": 0.5 }), edges });
  const two = pprScores({ seeds: seeds({ "c.md": 0.5, "a.md": 1 }), edges: [...edges].reverse() });
  assert.deepEqual([...one].sort(), [...two].sort());
  assert.deepEqual(pprScores({ seeds: seeds({ "a.md": 1, "c.md": 0.5 }), edges }), one);
});

test("pprScores: no seeds, or only zero weights, score nothing", () => {
  assert.equal(pprScores({ seeds: new Map(), edges: [["a.md", "b.md", 1]] }).size, 0);
  assert.equal(pprScores({ seeds: seeds({ "a.md": 0 }), edges: [["a.md", "b.md", 1]] }).size, 0);
});

test("fusePpr: a strong graph-only note enters the top ten; a weak one does not", () => {
  const lexical = Array.from({ length: 10 }, (_, i) => `l${i}.md`);
  const strong = fusePpr(lexical, new Map([["l0.md", 0.4], ["g.md", 0.4]]), { pinned: 0, weight: 1 });
  assert.ok(strong.slice(0, 10).includes("g.md"), strong.join());
  assert.ok(!strong.slice(0, 10).includes("l9.md"), "it displaced the weakest lexical hit");
  const weak = fusePpr(lexical, new Map([["l0.md", 0.9], ["g.md", 0.01]]), { pinned: 0, weight: 1 });
  assert.ok(!weak.slice(0, 10).includes("g.md"));
  assert.deepEqual(weak.slice(0, 10), lexical);
});

test("fusePpr: pinned lexical hits keep their places; ties break by key; no scores gives the lexical order", () => {
  const lexical = ["a.md", "b.md", "c.md", "d.md"];
  const scores = new Map([["z.md", 1], ["d.md", 0.9], ["c.md", 0.8]]);
  assert.deepEqual(fusePpr(lexical, scores, { pinned: 3, weight: 5 }).slice(0, 3), ["a.md", "b.md", "c.md"]);
  assert.equal(fusePpr(lexical, scores, { pinned: 0, weight: 5 })[0], "z.md");
  assert.deepEqual(fusePpr(lexical, new Map(), { pinned: 0, weight: 1 }), lexical);
  assert.deepEqual(fusePpr([], new Map([["y.md", 1], ["x.md", 1]]), { pinned: 0, weight: 1 }), ["x.md", "y.md"]);
});
