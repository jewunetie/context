// Personalized PageRank ranking for graph-assisted search (variant "ppr",
// SEARCH_GRAPH_BOOST). A random walk with restart from the top lexical hits,
// over the notes within PPR_HOPS links of them in both link directions, in
// memory. Pure maths (`pprScores`, `fusePpr`) and a bounded store walk
// (`pprWalk`) that only ever sees what the caller may see.
//
// Request cost. Every read goes through the search budget and a local cap,
// PPR_READ_CAP. A seed costs one node record plus its incoming posting (1
// page, plus 1 for a bare-name posting when the name is unique) and one
// record per visible backlink; the same again for each of the PPR_EXPAND most
// promising neighbours. A hub (more than HUB_DEGREE_CAP visible citers) is not
// expanded, which bounds one node at HUB_DEGREE_CAP + 3 reads; the cap bounds
// the walk. Measured on the HotpotQA slice (3.25 kept links per note): 139
// reads per query on top of the lexical search's 28, 231 at most, and 24 of
// 300 walks hit the cap and were withheld. On the synthetic link set, 35.5
// per query in all (78 at most) against 8.7 for lexical. At the default SEARCH_SUBREQUEST_BUDGET of 40
// the walk cannot finish and the answer is the lexical one, labelled, so this
// variant needs a deployment budget of several hundred.
//
// Privacy. Out-degree, hub detection, the node cap and every ordering use
// visible data only: postings are filtered by `see` before anything is
// counted, links resolve against the caller's catalog, and candidates are
// ordered by score then path, never by chain order. What a hidden note can
// still change is whether the walk finishes inside the cap and the budget (a
// hidden entry adds a posting page past 256 entries): then the whole walk is
// withheld, the one all-or-none bit docs/decisions/link-graph.md records.
import { resolveReference } from "../links.js";
import { HUB_DEGREE_CAP } from "./neighbors.js";
import { nameHash, pathHash } from "./keys.js";
import { graphView } from "./mode.js";
import { readPostings } from "./postings.js";
import { readNode, validateEntry } from "./project.js";

// Experiment parameters, to be tuned in Phase 5 (README 12.3).
export const PPR_SEEDS = 10; // top lexical hits that seed the walk
export const PPR_RESTART = 0.15; // chance per step of returning to a seed
export const PPR_ITERATIONS = 20; // power iterations
export const PPR_HOPS = 2; // links out from a seed, either direction
export const PPR_EXPAND = 10; // neighbours expanded per hop beyond the seeds
export const PPR_NODE_CAP = 60; // notes in the walk, seeds first
export const PPR_READ_CAP = 200; // store reads the walk may spend
export const PPR_WEIGHT = 0.5; // PPR against lexical (1 at rank 1) in the fusion
export const PPR_PINNED = 0; // lexical hits that keep their places

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `Map<path, score>` summing to 1. `seeds` maps a path to a positive weight
 * (the restart distribution); `edges` is `[from, to, weight][]`, a link from
 * `from` to `to` weighing 1 / (visible links of `from`). The walk crosses an
 * edge either way at that weight, normalised over the edges at the node it
 * stands on, so a link from a note with 200 links is a thin path and a node
 * reached along several paths collects from each. A node with no edge sends
 * its mass back to the seeds. Nodes are indexed in path order and every sum
 * runs in that order, so the floats are the same whatever order the input came.
 */
export function pprScores({ seeds, edges, restart = PPR_RESTART, iterations = PPR_ITERATIONS }) {
  const start = [...seeds].filter(([, w]) => w > 0);
  const total = start.reduce((n, [, w]) => n + w, 0);
  if (!(total > 0)) return new Map();
  const nodes = [...new Set([...start.map(([p]) => p), ...edges.flatMap(([a, b]) => [a, b])])].sort(byPath);
  const at = new Map(nodes.map((p, i) => [p, i]));
  const restartAt = new Float64Array(nodes.length);
  for (const [p, w] of start) restartAt[at.get(p)] = w / total;
  const rows = nodes.map(() => new Map());
  for (const [a, b, w] of edges) {
    if (a === b || !(w > 0)) continue;
    const [i, j] = [at.get(a), at.get(b)];
    rows[i].set(j, (rows[i].get(j) ?? 0) + w);
    rows[j].set(i, (rows[j].get(i) ?? 0) + w);
  }
  const steps = rows.map((row) => {
    const sorted = [...row].sort((x, y) => x[0] - y[0]);
    return { sorted, sum: sorted.reduce((n, [, w]) => n + w, 0) };
  });
  let rank = Float64Array.from(restartAt);
  for (let step = 0; step < iterations; step += 1) {
    const next = new Float64Array(nodes.length);
    let lost = 0;
    steps.forEach(({ sorted, sum }, i) => {
      const mass = (1 - restart) * rank[i];
      if (!(sum > 0)) lost += mass;
      else for (const [j, w] of sorted) next[j] += (mass * w) / sum;
    });
    for (let i = 0; i < nodes.length; i += 1) next[i] += (restart + lost) * restartAt[i];
    rank = next;
  }
  return new Map(nodes.map((p, i) => [p, rank[i]]));
}

/**
 * One order from the lexical keys and the PPR scores (keyed like the lexical
 * keys where a note is a hit, by path where it is not). A key scores
 * 1 / lexical rank (rank 1 is 1) plus `weight` times its PPR score over the
 * largest score, so a graph-only note with a share of the top PPR mass can
 * pass lexical ranks below it. The first `pinned` lexical keys keep their
 * places. Ties by key.
 */
export function fusePpr(lexical, scores, { pinned, weight }) {
  const head = lexical.slice(0, pinned);
  const fixed = new Set(head);
  const top = Math.max(0, ...scores.values());
  const total = new Map();
  lexical.forEach((key, i) => total.set(key, 1 / (i + 1)));
  if (top > 0) for (const [key, s] of scores) total.set(key, (total.get(key) ?? 0) + (weight * s) / top);
  const tail = [...total].filter(([key]) => !fixed.has(key)).sort(([a, x], [b, y]) => y - x || byPath(a, b)).map(([key]) => key);
  return [...head, ...tail];
}

/** A budget that also stops at `cap` reads of its own. */
function capped(budget, cap) {
  let spent = 0;
  return {
    get remaining() {
      return Math.min(cap - spent, budget.remaining);
    },
    take(reserve = 0) {
      if (spent >= cap || !budget.take(reserve)) return false;
      spent += 1;
      return true;
    },
  };
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/**
 * `Map<path, score>` over the bounded neighbourhood of `seeds` (`[{ path,
 * weight }]` in rank order), or null when the walk could not finish: a refused
 * or failed read, an unfinished posting chain, a seed with no node record,
 * the cap or the budget reached. Never a partial walk. `catalog` and `see`
 * are the caller's (`see` is synchronous, as `isVisible`); `gen` is the one
 * pinned graph generation.
 */
export async function pprWalk(store, budget, { gen, seeds, catalog, see }) {
  const reads = capped(budget, PPR_READ_CAP);
  const view = graphView(store, reads);
  const shown = catalog.paths;
  const records = new Map(); // path -> parsed node record or null, shared with validation
  const validate = validateEntry(view, reads, gen, records);
  const unfinished = () => {
    throw new Error("ppr walk unfinished");
  };
  const recordOf = async (path) => {
    if (!records.has(path)) {
      const got = await readNode(view, reads, gen, path);
      if (!got) unfinished();
      records.set(path, got.old);
    }
    return records.get(path);
  };
  const linksOf = new Map(); // path -> visible, listed .md targets
  const outsOf = async (path) => {
    if (!linksOf.has(path)) {
      const node = await recordOf(path);
      const out = new Set();
      if (node && node.coverage !== "excluded") {
        for (const occ of node.occurrences) {
          const r = resolveReference(occ, path, catalog);
          if (r.state === "resolved" && r.path !== path && r.path.endsWith(".md") && shown.has(r.path)) out.add(r.path);
        }
      }
      linksOf.set(path, out);
    }
    return linksOf.get(path);
  };

  const edges = new Map(); // from -> Map(to -> weight)
  const link = (from, to, w) => {
    if (!edges.has(from)) edges.set(from, new Map());
    edges.get(from).set(to, w);
  };
  const edgeList = () => [...edges].flatMap(([from, row]) => [...row].map(([to, w]) => [from, to, w]));
  const known = new Set(seeds.map((s) => s.path));
  const expanded = new Set();

  const expand = async (x) => {
    expanded.add(x);
    const citers = new Map(); // source -> posting entries
    const read = async (family, hash) => {
      const { entries, complete } = await readPostings(view, reads, { gen, family, hash, canSee: see, validate: async () => true });
      if (!complete) unfinished();
      for (const e of entries) if (e.source !== x) citers.set(e.source, [...(citers.get(e.source) ?? []), e]);
    };
    await read("incoming", await pathHash(x));
    // Late binding (arch 7.4): a bare citer counts only for a name unique in the caller's catalog.
    const name = baseName(x);
    const named = catalog.byName?.get(name);
    if (named?.length === 1 && named[0] === x) await read("bare", await nameHash(name));
    if (citers.size > HUB_DEGREE_CAP) return; // a hub is a node, not a path
    const out = await outsOf(x);
    for (const t of out) {
      link(x, t, 1 / out.size);
      known.add(t);
    }
    for (const source of citers.keys()) {
      if (!shown.has(source)) continue;
      let valid = false;
      for (const e of citers.get(source)) if (!valid && (await validate(e))) valid = true;
      if (!valid) continue;
      const theirs = await outsOf(source);
      link(source, x, 1 / (theirs.has(x) ? theirs.size : theirs.size + 1));
      known.add(source);
    }
  };

  const seedWeights = new Map(seeds.map((s) => [s.path, s.weight]));
  const walk = () => pprScores({ seeds: seedWeights, edges: edgeList() });
  const rankedBy = (scores, paths) => [...paths].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || byPath(a, b));
  try {
    for (const { path } of seeds) {
      if (!(await recordOf(path))) unfinished();
      await expand(path);
    }
    for (let hop = 1; hop < PPR_HOPS; hop += 1) {
      const scores = walk();
      for (const path of rankedBy(scores, [...known].filter((p) => !expanded.has(p))).slice(0, PPR_EXPAND)) await expand(path);
    }
    const scores = walk();
    if (known.size <= PPR_NODE_CAP) return scores;
    // Over the cap: keep the seeds and the best of the rest, by score then path.
    const kept = new Set([...seedWeights.keys(), ...rankedBy(scores, [...known].filter((p) => !seedWeights.has(p)))].slice(0, PPR_NODE_CAP));
    return pprScores({ seeds: seedWeights, edges: edgeList().filter(([a, b]) => kept.has(a) && kept.has(b)) });
  } catch {
    return null;
  }
}
