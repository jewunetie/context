/**
 * Related-note candidates for one caller (`src/graph/retrieve.js`, Task 16).
 * Fixtures project every note with `projectNote` and converge the sharded
 * search index over the same `memoryBucket`, so lexical and graph reasons come
 * from the stores the gateway reads. Fixtures stay under 300 notes, so the
 * index is one shard and the search walk itself spends the same whatever the
 * hidden notes say (the multi-shard routing residual is search's own,
 * documented in src/search/visible.js, answerFromIndex).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   limit before canSee (search isVisible () => true, filter after slice)  2 (hidden strong match, invariance)
 *   best-effort label dropped (graph.health.possiblyIncomplete ignored)    1 (P4)
 *   graph run before search on the shared budget                           1 (invariance)
 *   catalog built from every docmap path, not the visible ones             1 (invariance)
 *   link and URL targets left in the seed's query words                    2 (canonical reasons, unavailable graph)
 *   explicit links not ranked ahead of text-only hits                      1 (hub)
 *   nearby added as a candidate of its own                                 2 (nearby, link_suggestions)
 *   encrypted seed queried for text                                        1 (encrypted seed)
 *
 * RED: the file failed to load on the missing module before retrieve.js existed.
 *
 * Fix round 1 (each new test red first against 24a76905):
 *   no budget check before searching for a strict caller                   2 (multi-shard invariance, all or none)
 *   the check applied to the owner too                                      1 (all or none)
 *   SEARCH_OVERHEAD 0 instead of 1                                          1 (all or none, at its boundary)
 *   catalog.paths only on a converged index (the old rule)                  1 (hidden edit behind)
 *   catalog.partial ignored by resolveReference                             2 (hidden edit behind, resolveReference)
 *   canSeeKey not awaited                                                   1 (async canSeeKey)
 *   manifest not handed to search                                           1 (one manifest read)
 *
 * Task 17 fix round 1 (each new test red first against dbb13820):
 *   candidates under an active move not withheld                            1 (active move)
 *   active move not labelling possiblyIncomplete                            1 (active move)
 *   unreadable job state treated as no jobs (fail open)                     1 (unreadable move job)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { retrieveCandidates } from "../src/graph/retrieve.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { indexIsBehind, loadIndexManifest, MANIFEST_KEY, syncShardedIndex } from "../src/search/shards.js";
import { extractReferences, indexByName, resolveReference } from "../src/links.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { moveJobKey, writeMoveSentinel } from "../src/moves/jobs.js";

const gen = "1";
const now = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const team = (p) => !p.startsWith("private/");
const owner = () => true;
const SEED = "notes/seed.md";
const indexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));
const ENCRYPTED = "---\ncontext_encryption: v1\n---\nciphertext kestrel";

/**
 * A bucket holding `notes`, their graph projections and a converged index.
 * `conditional` gives the store both probed capabilities; `ready` marks the
 * graph swept, so a positive control can read `possiblyIncomplete: false`.
 */
async function world(notes, { conditional = false, ready = false, graph = true } = {}) {
  const store = memoryBucket();
  if (conditional) store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (const [path, body] of Object.entries(notes)) await store.put(path, body);
  if (graph) {
    await initGraphManifest(store, big(), { mode: "conditional", now });
    for (const [path, body] of Object.entries(notes)) {
      const { state } = await projectNote(store, path, body, "1", { budget: big(), gen, mode: "conditional", now });
      assert.equal(state, "projected", path);
    }
    if (ready) {
      const m = JSON.parse(store.objects.get(graphManifestKey()).body);
      await store.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "ready", sweepComplete: true } }));
    }
  }
  for (let pass = 0; pass < 60; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  return store;
}

function ask(store, notes, options = {}) {
  const { seed = SEED, canSeeKey = team, budget = big(), limits, intent = "related_notes", sections } = options;
  const scope = Object.hasOwn(options, "scope") ? options.scope : canSeeKey === owner ? "private" : "workspace";
  return retrieveCandidates(store, {
    seed: { path: seed, body: notes[seed], ...(sections && { sections }) },
    intent,
    canSeeKey,
    isIndexable: indexable,
    budget,
    limits,
    scope,
  });
}

const paths = (r) => r.relations.map((x) => x.path);
const byPath = (r) => Object.fromEntries(r.relations.map((x) => [x.path, x]));
const hidden = (n, body, prefix = "h") =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/${prefix}${i}.md`, typeof body === "function" ? body(i) : body]));

test("an unlinked note comes back through related_text, with evidence from its snippet; the seed never does", async () => {
  const notes = {
    [SEED]: "# Kestrel migration\n\nWe move the kestrel cluster to the harbor region.\n",
    "far/away/far.md": "Unrelated intro.\nThe kestrel cluster migration finished in harbor.\n",
    "far/away/none.md": "Nothing in common at all.\n",
  };
  const r = await ask(await world(notes), notes);
  assert.ok(!paths(r).includes(SEED));
  assert.ok(!paths(r).includes("far/away/none.md"));
  assert.deepEqual(byPath(r)["far/away/far.md"], {
    path: "far/away/far.md",
    reasons: ["related_text"],
    evidence: "The kestrel cluster migration finished in harbor.",
  });
});

test("graph reasons carry no evidence; every reason of a note is kept, in canonical order", async () => {
  const notes = {
    [SEED]: "# Kestrel\n\nSee [[t/target]] and [p](https://example.com/page).\n",
    "t/target.md": "plain",
    "notes/back.md": "kestrel notes link [[notes/seed]] and cite [[t/target]] and [q](https://example.com/page)",
    "x/y/cotarget.md": "[[t/target]]",
    "x/y/courl.md": "[q](https://example.com/page)",
  };
  const r = await ask(await world(notes), notes);
  const got = byPath(r);
  assert.deepEqual(got["notes/back.md"].reasons, ["links_here", "shares_target", "shares_url", "related_text", "nearby"]);
  assert.ok(got["notes/back.md"].evidence);
  // Link targets are not query words, so the target and the co-citers are not text hits.
  assert.deepEqual(got["t/target.md"], { path: "t/target.md", reasons: ["linked_from_here", "nearby"] });
  assert.deepEqual(got["x/y/cotarget.md"], { path: "x/y/cotarget.md", reasons: ["shares_target"] });
  assert.deepEqual(got["x/y/courl.md"], { path: "x/y/courl.md", reasons: ["shares_url"] });
});

test("nearby is only ever added to a candidate selected for another reason", async () => {
  const notes = {
    [SEED]: "# Kestrel\n\nkestrel harbor\n",
    "notes/sibling.md": "nothing shared",
    "notes/deep/a/b.md": "kestrel harbor too",
    "notes/near.md": "kestrel harbor again",
  };
  const r = await ask(await world(notes), notes);
  assert.ok(!paths(r).includes("notes/sibling.md"));
  assert.deepEqual(byPath(r)["notes/near.md"].reasons, ["related_text", "nearby"]);
  // dir depth 1 and 3, common prefix depth 1: distance 1 + 3 - 2 = 2.
  assert.deepEqual(byPath(r)["notes/deep/a/b.md"].reasons, ["related_text", "nearby"]);
});

test("an unavailable graph returns the lexical results and the body's own links, labelled possiblyIncomplete", async () => {
  const notes = {
    [SEED]: "# Kestrel migration\n\nkestrel harbor [[t/target]]\n",
    "t/target.md": "target",
    "far/away/far.md": "kestrel harbor migration",
    "other/back.md": "[[notes/seed]]",
  };
  const r = await ask(await world(notes, { conditional: true, graph: false }), notes);
  assert.equal(r.possiblyIncomplete, true);
  assert.deepEqual(byPath(r)["far/away/far.md"].reasons, ["related_text"]);
  assert.deepEqual(byPath(r)["t/target.md"].reasons, ["linked_from_here", "nearby"]);
  assert.ok(!paths(r).includes("far/away/back.md"));
});

test("a best-effort store always labels possiblyIncomplete; a conditional, ready, converged one does not", async () => {
  const notes = { [SEED]: "# Kestrel\n\nkestrel harbor\n", "far/away/far.md": "kestrel harbor", "n/back.md": "[[notes/seed]]" };
  const good = await ask(await world(notes, { conditional: true, ready: true }), notes);
  assert.equal(good.possiblyIncomplete, false);
  assert.deepEqual(paths(good).sort(), ["far/away/far.md", "n/back.md"]);
  const p4 = await ask(await world(notes, { ready: true }), notes);
  assert.equal(p4.possiblyIncomplete, true);
  assert.deepEqual(p4.relations, good.relations);
});

test("hub co-citers do not bury an exact text hit; explicit links are not dropped for text hits", async () => {
  const notes = {
    [SEED]: "# Ostrava turbine\n\nostrava turbine bearing [[t/hub]]\n",
    "t/hub.md": "hub",
    "z/exact.md": "# Ostrava turbine\n\nostrava turbine bearing",
  };
  for (let i = 0; i < 40; i += 1) notes[`c/co${String(i).padStart(2, "0")}.md`] = "[[t/hub]]";
  const r = await ask(await world(notes, { conditional: true, ready: true }), notes, { limits: { results: 3 } });
  assert.equal(r.relations.length, 3);
  assert.equal(r.relations[0].path, "t/hub.md");
  assert.ok(paths(r).includes("z/exact.md"), JSON.stringify(paths(r)));
});

test("limit applies after canSee: hidden strong matches do not reduce the visible count", async () => {
  const notes = { [SEED]: "# Quokka ledger\n\nquokka ledger reconciliation\n" };
  for (let i = 0; i < 6; i += 1) notes[`v/v${i}.md`] = `quokka mention ${i} among many other unrelated words here`;
  Object.assign(notes, hidden(10, "# Quokka ledger\n\nquokka ledger reconciliation quokka ledger"));
  const store = await world(notes);
  const r = await ask(store, notes, { limits: { results: 5 } });
  assert.equal(r.relations.length, 5);
  assert.ok(r.relations.every((x) => team(x.path)), JSON.stringify(paths(r)));
  const forOwner = await ask(store, notes, { canSeeKey: owner, limits: { results: 5 } });
  assert.ok(forOwner.relations.every((x) => x.path.startsWith("private/")));
});

test("link_suggestions takes its terms from the given sections and their headings only", async () => {
  const body = "# Notes\n\nzebrafish appear here\n\n## Changed\n\nwombat burrow survey\n";
  const notes = { [SEED]: body, "a/zebra.md": "zebrafish zebrafish", "a/wombat.md": "wombat burrow survey" };
  const start = body.indexOf("## Changed");
  const sections = [{ heading: "Changed", depth: 2, start, end: body.length, text: body.slice(start) }];
  const r = await ask(await world(notes), notes, { intent: "link_suggestions", sections });
  assert.ok(paths(r).includes("a/wombat.md"));
  assert.ok(!paths(r).includes("a/zebra.md"));
});

test("an encrypted seed asks no text query: backlinks only", async () => {
  const notes = { [SEED]: ENCRYPTED, "far/away/x.md": "kestrel ciphertext", "far/away/back.md": "[[notes/seed]]" };
  const r = await ask(await world(notes), notes);
  assert.deepEqual(r.relations, [{ path: "far/away/back.md", reasons: ["links_here"] }]);
});

test("never throws: a failing store, a throwing canSeeKey, a hidden seed", async () => {
  const notes = { [SEED]: "# Kestrel\n\nkestrel [[t/target]]\n", "t/target.md": "kestrel" };
  const broken = { get: async () => { throw new Error("boom"); }, put: async () => null, list: async () => { throw new Error("boom"); } };
  const a = await ask(broken, notes);
  assert.equal(a.possiblyIncomplete, true);
  assert.ok(Array.isArray(a.relations));

  const store = await world(notes);
  const canSeeKey = (p) => { if (p === "t/target.md") throw new Error("boom"); return true; };
  const b = await ask(store, notes, { canSeeKey });
  assert.ok(!paths(b).includes("t/target.md"));

  let gets = 0;
  const counting = { ...store, get: (k) => ((gets += 1), store.get(k)), list: (o) => ((gets += 1), store.list(o)) };
  const budget = big();
  const c = await ask(counting, { "private/seed.md": "kestrel" }, { seed: "private/seed.md", budget });
  assert.deepEqual([c.relations, c.unresolved, gets, budget.spent], [[], [], 0, 0]);
});

test("budget.spent and the store ops made never exceed the budget given", async () => {
  const notes = {
    [SEED]: "# Kestrel\n\nkestrel harbor [[t/target]] [p](https://example.com/page)\n",
    "t/target.md": "kestrel",
    "n/back.md": "[[notes/seed]] kestrel",
    "n/co.md": "[[t/target]] harbor",
    "n/url.md": "[p](https://example.com/page)",
  };
  const store = await world(notes);
  let ops = 0;
  let moveOps = [];
  // The move-job read is outside the budget, the same reads read_note's
  // overlay makes (fix round 3), so it is counted apart: here one listing.
  const count = (k) => (String(k).startsWith(".context/moves/") ? moveOps.push(String(k)) : (ops += 1));
  const counting = {
    ...store,
    get: (k) => (count(k), store.get(k)),
    put: (k, v, o) => (count(k), store.put(k, v, o)),
    list: (o) => (count(o?.prefix), store.list(o)),
  };
  for (let B = 0; B <= 40; B += 1) {
    ops = 0;
    moveOps = [];
    const budget = createSearchBudget(B);
    await ask(counting, notes, { budget });
    assert.ok(budget.spent <= B, `B=${B} spent ${budget.spent}`);
    assert.ok(ops <= B, `B=${B} ops ${ops}`);
    assert.deepEqual(moveOps, [".context/moves/"], `B=${B}`);
  }
});

test("privacy invariance: hidden notes change nothing but the withheld graph bit, at tight and generous budgets", async () => {
  const base = {
    [SEED]: "# Kestrel harbor\n\nkestrel harbor survey [[t/target]] [p](https://example.com/page)\n",
    "t/target.md": "target note",
    "notes/back.md": "[[notes/seed]] about the harbor",
    "notes/cotarget.md": "[[t/target]]",
    "notes/courl.md": "[p](https://example.com/page)",
    "other/text.md": "kestrel harbor survey results",
    "other/text2.md": "a kestrel was seen",
  };
  const H = 260; // over POSTING_PAGE_SIZE (256): one more page in a chain
  const variants = {
    "hidden strong text matches": hidden(H, "# Kestrel harbor\n\nkestrel harbor survey kestrel harbor survey"),
    "hidden backlinks": hidden(H, "[[notes/seed]]"),
    "hidden bare backlinks": hidden(H, "[[seed]]"),
    "hidden co-citers": hidden(H, "[[t/target]] kestrel"),
    "hidden URL citers": hidden(H, "[p](https://example.com/page)"),
    "a hidden note named like the seed": { "private/seed.md": "kestrel harbor survey", "private/target.md": "[[notes/seed]]" },
  };
  const opts = { conditional: true, ready: true };
  const plainStore = await world(base, opts);
  // The withheld oracle: the same bucket with the graph unavailable, which is
  // the answer graphNeighbors gives a strict caller when a chain is unfinished.
  const withheldStore = { ...plainStore, get: (k) => (k === graphManifestKey() ? null : plainStore.get(k)) };
  const stores = {};
  for (const [k, v] of Object.entries(variants)) stores[k] = await world({ ...base, ...v }, opts);
  const withheldAt = new Set();
  for (let B = 0; B <= 60; B += 1) {
    const none = JSON.stringify(await ask(plainStore, base, { budget: createSearchBudget(B) }));
    const withheld = JSON.stringify(await ask(withheldStore, base, { budget: createSearchBudget(B) }));
    for (const [k, v] of Object.entries(variants)) {
      const out = JSON.stringify(await ask(stores[k], { ...base, ...v }, { budget: createSearchBudget(B) }));
      assert.ok(out === none || out === withheld, `B=${B} ${k}:\n${out}\nnone ${none}\nwithheld ${withheld}`);
      if (out !== none) withheldAt.add(k);
      if (B === 60) assert.equal(out, none, k);
    }
  }
  // The page-adding variants do reach the withheld answer at some budget, so the bit is exercised.
  for (const k of ["hidden backlinks", "hidden bare backlinks", "hidden co-citers", "hidden URL citers"]) assert.ok(withheldAt.has(k), k);
  const full = await ask(plainStore, base, { budget: createSearchBudget(60) });
  assert.equal(full.possiblyIncomplete, false);
  assert.deepEqual(paths(full).sort(), ["notes/back.md", "notes/cotarget.md", "notes/courl.md", "other/text.md", "other/text2.md", "t/target.md"]);
});

// Fix round 1 (review 1 of Task 16).

const MULTI = {
  [SEED]: "# Kestrel harbor\n\nkestrel harbor survey [[t/target]] [p](https://example.com/page)\n",
  "t/target.md": "target note",
  "notes/back.md": "[[notes/seed]] about the harbor",
  "notes/cotarget.md": "[[t/target]]",
  "notes/courl.md": "[p](https://example.com/page)",
  "other/text.md": "kestrel harbor survey results",
  "other/text2.md": "a kestrel was seen",
  "other/text3.md": "harbor survey of the coast, kestrel nests, harbor again",
};

test("multi-shard privacy invariance: hidden notes change only the withheld text bit and the withheld graph bit, budgets 0..80", async () => {
  const opts = { conditional: true, ready: true };
  const plainStore = await world(MULTI, opts);
  const withheldStore = { ...plainStore, get: (k) => (k === graphManifestKey() ? null : plainStore.get(k)) };
  const variants = {
    "700 hidden strong text matches": hidden(700, "# Kestrel harbor\n\nkestrel harbor survey kestrel harbor survey"),
    "700 hidden unrelated notes": hidden(700, (i) => `filler word${i} alpha${i}`),
    "700 hidden backlinks": hidden(700, "[[notes/seed]]"),
    "700 hidden long notes": hidden(700, (i) => `kestrel ${"padding ".repeat(200)} ${i}`),
  };
  const stores = {};
  for (const [k, v] of Object.entries(variants)) {
    stores[k] = await world({ ...MULTI, ...v }, opts);
    assert.ok((await loadIndexManifest(stores[k], big(), 0)).shardCount > 1, k);
  }
  // Text withheld: a results limit no budget here covers makes a strict
  // caller skip text on the plain bucket for the same spend (no candidate
  // list here reaches the default limit, so the cut is the same).
  const NO_TEXT = { results: 100000 };
  const seen = new Set();
  for (let B = 0; B <= 80; B += 1) {
    const at = async (store, limits) => JSON.stringify(await ask(store, MULTI, { budget: createSearchBudget(B), limits }));
    const outcomes = new Map([
      [await at(plainStore), "none"],
      [await at(withheldStore), "graph withheld"],
      [await at(plainStore, NO_TEXT), "text withheld"],
      [await at(withheldStore, NO_TEXT), "both withheld"],
    ]);
    for (const [k, v] of Object.entries(variants)) {
      const out = JSON.stringify(await ask(stores[k], { ...MULTI, ...v }, { budget: createSearchBudget(B) }));
      assert.ok(outcomes.has(out), `B=${B} ${k}:\n${out}\n${JSON.stringify([...outcomes])}`);
      seen.add(outcomes.get(out));
    }
  }
  assert.ok(seen.has("text withheld") || seen.has("both withheld"), [...seen].join());
  const generous = JSON.stringify(await ask(plainStore, MULTI, { budget: createSearchBudget(5000) }));
  for (const [k, v] of Object.entries(variants)) {
    assert.equal(JSON.stringify(await ask(stores[k], { ...MULTI, ...v }, { budget: createSearchBudget(5000) })), generous, k);
  }
});

test("text hits are all or none for a strict caller; the owner keeps them on an index larger than the budget", async () => {
  const notes = { ...MULTI, ...hidden(700, (i) => `filler word${i}`) };
  const store = await world(notes, { conditional: true, ready: true });
  const occupied = (await loadIndexManifest(store, big(), 0)).stats.filter((e) => e.docCount > 0).length;
  assert.ok(occupied > 1);
  // Two catalog reads, then one short of every shard, 11 hits and the
  // re-check's reserve. The move-job read is outside the budget (fix round 3).
  const B = 2 + occupied + 11;
  const strict = await ask(store, notes, { budget: createSearchBudget(B) });
  assert.ok(!strict.relations.some((r) => r.reasons.includes("related_text")), JSON.stringify(strict));
  assert.equal(strict.possiblyIncomplete, true);
  const forOwner = await ask(store, notes, { canSeeKey: owner, budget: createSearchBudget(B) });
  assert.ok(forOwner.relations.some((r) => r.reasons.includes("related_text")), JSON.stringify(forOwner));
  const enough = await ask(store, notes, { budget: createSearchBudget(B + 1) });
  assert.ok(enough.relations.some((r) => r.reasons.includes("related_text")), JSON.stringify(enough));
});

test("excludeLinked drops linked targets before the cut, and the strict text gate covers the wider search", async () => {
  const links = Array.from({ length: 4 }, (_, i) => `[[t/l${i}]]`).join(" ");
  const notes = { ...MULTI, [SEED]: `# Kestrel harbor\n\nkestrel harbor survey ${links}\n`, ...hidden(700, (i) => `filler word${i}`) };
  for (let i = 0; i < 4; i += 1) notes[`t/l${i}.md`] = `kestrel harbor survey ${i}`;
  const store = await world(notes, { conditional: true, ready: true });
  const occupied = (await loadIndexManifest(store, big(), 0)).stats.filter((e) => e.docCount > 0).length;
  const ask2 = (budget) =>
    retrieveCandidates(store, { seed: { path: SEED, body: notes[SEED] }, intent: "related_notes", canSeeKey: team, isIndexable: indexable, budget, scope: "workspace", excludeLinked: true });
  const generous = await ask2(big());
  assert.ok(!generous.relations.some((r) => r.reasons.includes("linked_from_here")), JSON.stringify(generous));
  assert.ok(generous.relations.some((r) => r.reasons.includes("related_text")));
  // Two catalog reads, then one short of every shard, 10 + 4 hits and the re-check's reserve.
  const B = 2 + occupied + 11 + 4;
  const short = await ask2(createSearchBudget(B));
  assert.ok(!short.relations.some((r) => r.reasons.includes("related_text")), JSON.stringify(short));
  const enough = await ask2(createSearchBudget(B + 1));
  assert.ok(enough.relations.some((r) => r.reasons.includes("related_text")), JSON.stringify(enough));
});

test("a hidden edit that leaves the index behind does not drop the seed's rooted links", async () => {
  const notes = { [SEED]: "# Kestrel\n\nsee [t](../t/target.md) and [[t/two]] and [g](../t/gone.md) kestrel\n", "t/target.md": "target", "t/two.md": "two", "other/text.md": "kestrel" };
  const store = await world(notes, { conditional: true, ready: true });
  const before = await ask(store, notes);
  assert.deepEqual(before.unresolved.map((u) => u.state), ["missing"]);
  await store.put("private/new.md", "a hidden edit");
  await syncShardedIndex(store, { budget: createSearchBudget(3), isIndexable: indexable });
  assert.ok(indexIsBehind((await loadIndexManifest(store, big(), 0)).freshness));
  const after = await ask(store, notes);
  assert.deepEqual(after.relations, before.relations);
  // Behind, an absent target is not known to be absent.
  assert.deepEqual(after.unresolved.map((u) => u.state), ["unknown"]);
});

test("resolveReference with catalog.partial: a path in the list resolves, one outside it is unknown", () => {
  const catalog = { byName: indexByName(["t/a.md"]), paths: new Set(["t/a.md"]), partial: true };
  const [a, b, c] = extractReferences("[a](t/a.md) [b](t/b.md) [[nothing]]");
  assert.deepEqual(resolveReference(a, "x.md", catalog), { state: "resolved", path: "t/a.md" });
  assert.deepEqual(resolveReference(b, "x.md", catalog), { state: "unknown" });
  assert.deepEqual(resolveReference(c, "x.md", catalog), { state: "unknown" });
  assert.deepEqual(resolveReference(b, "x.md", { ...catalog, partial: false }), { state: "missing" });
});

test("an async canSeeKey is awaited, and a rejecting one counts as not visible", async () => {
  const notes = { ...MULTI };
  const store = await world(notes, { conditional: true, ready: true });
  const sync = JSON.stringify(await ask(store, notes));
  assert.equal(JSON.stringify(await ask(store, notes, { canSeeKey: async (p) => team(p) })), sync);
  const rejecting = async (p) => { if (p === "other/text.md") throw new Error("boom"); return team(p); };
  const r = await ask(store, notes, { canSeeKey: rejecting });
  assert.ok(!paths(r).includes("other/text.md"));
  assert.ok(paths(r).includes("other/text2.md"));
});

test("one call reads the search index manifest once", async () => {
  const store = await world(MULTI, { conditional: true, ready: true });
  let reads = 0;
  const counting = { ...store, get: (k) => ((reads += k === MANIFEST_KEY ? 1 : 0), store.get(k)) };
  const r = await ask(counting, MULTI);
  assert.ok(r.relations.some((x) => x.reasons.includes("related_text")));
  assert.equal(reads, 1);
});

// Fix round 1 (Task 17 review): candidates resolve on physical paths, so a
// note under an active logical move would be shown at its source while
// read_note refuses it (moved into a private folder). Every candidate under an
// active job's source or destination is withheld, and the answer is labelled.
const job = (id, source, destination, status = "logical_active") =>
  JSON.stringify({ version: 1, id, source, destination, status, created_at: "2026-01-01", objects: [{ source: `${source}/a.md`, destination: `${destination}/a.md` }] });

test("a note under an active move's source or destination is withheld, and the answer is labelled", async () => {
  const notes = {
    [SEED]: "# Kestrel migration\n\nThe kestrel migration plan, see [[alpha]].\n",
    "notes/alpha.md": "# Alpha\n",
    "notes/mv/a.md": "kestrel migration secret [[seed]]\n",
    "notes/other.md": "kestrel migration too [[seed]]\n",
  };
  const store = await world(notes, { conditional: true, ready: true });
  const before = await ask(store, notes);
  assert.ok(paths(before).includes("notes/mv/a.md"), "non-vacuous: visible without a move");
  assert.equal(before.possiblyIncomplete, false);
  await writeMoveSentinel(store);
  await store.put(moveJobKey("job-0000000000001"), job("job-0000000000001", "notes/mv", "private/mv"));
  const during = await ask(store, notes);
  assert.ok(!paths(during).includes("notes/mv/a.md"), JSON.stringify(during));
  assert.ok(paths(during).includes("notes/other.md"));
  assert.equal(during.possiblyIncomplete, true);
  // A finished job withholds nothing.
  await store.put(moveJobKey("job-0000000000001"), job("job-0000000000001", "notes/mv", "private/mv", "complete"));
  assert.deepEqual(await ask(store, notes), before);
});

test("an unreadable move job withholds every candidate; a seed under a move gets nothing", async () => {
  const notes = {
    [SEED]: "# Kestrel migration\n\nSee [[alpha]].\n",
    "notes/alpha.md": "# Alpha kestrel\n",
  };
  const store = await world(notes, { conditional: true, ready: true });
  await writeMoveSentinel(store);
  await store.put(moveJobKey("job-0000000000002"), "{ half a marker");
  assert.deepEqual(await ask(store, notes), { relations: [], unresolved: [], possiblyIncomplete: true });
  await store.put(moveJobKey("job-0000000000002"), job("job-0000000000002", "notes", "private/notes"));
  assert.deepEqual(await ask(store, notes), { relations: [], unresolved: [], possiblyIncomplete: true });
});
