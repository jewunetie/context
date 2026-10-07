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
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { retrieveCandidates } from "../src/graph/retrieve.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { memoryBucket } from "./store/fixtures.mjs";

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
  for (let pass = 0; pass < 30; pass += 1) {
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
const hidden = (n, body, prefix = "h") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/${prefix}${i}.md`, body]));

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
  const counting = {
    ...store,
    get: (k) => ((ops += 1), store.get(k)),
    put: (k, v, o) => ((ops += 1), store.put(k, v, o)),
    list: (o) => ((ops += 1), store.list(o)),
  };
  for (let B = 0; B <= 40; B += 1) {
    ops = 0;
    const budget = createSearchBudget(B);
    await ask(counting, notes, { budget });
    assert.ok(budget.spent <= B, `B=${B} spent ${budget.spent}`);
    assert.ok(ops <= B, `B=${B} ops ${ops}`);
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
