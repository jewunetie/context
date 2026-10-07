/**
 * Post-write link suggestions (`src/graph/suggest.js`, Task 22). Fixtures
 * project every note with `projectNote` and converge the sharded search index
 * over one `memoryBucket`, as graphRetrieve.test.mjs does, and stay under 300
 * notes so the index is one shard.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   audience rule skipped (caller visibility only)                          2 (team source, group source)
 *   deadline checked only after I/O (take and remaining unguarded)          3 (first op, CPU, between sections)
 *   a retrieval the deadline reached kept instead of dropped                1 (dropped whole)
 *   committed links not resolved against the candidates                     3 (ready block, unreadable index, between sections)
 *   no trimming to the cap                                                  1 (4 KiB)
 *   untrusted strings not escaped                                           1 (4 KiB)
 *   "none" whenever nothing survives, even when no retrieval completed      5 (throwing store, deadlines, invariance)
 *   retrieval run with scope "private" for every caller                     1 (invariance)
 *
 * RED: the file failed to load on the missing module before suggest.js existed.
 *
 * Fix round 1 (each new test red first against 3401aa0f; counts span this file and graphRetrieve.test.mjs):
 *   excludeLinked not passed to retrieval                                   1 (more links than the limit)
 *   no over-fetch for linked targets                                        2 (more links than the limit, retrieve gate)
 *   strict text gate on the old limit                                       1 (retrieve gate)
 *   store not wrapped (budget only)                                         3 (crowded write, dropped whole, logical-delete)
 *   forked logical views not wrapped                                        1 (logical-delete)
 *   arguments destructured outside the try                                  1 (null arguments)
 *   fit drops the last candidate                                            1 (fit)
 *   an emptied list kept "ready"                                            1 (fit)
 *   \p{Cf} not escaped                                                      1 (format characters)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderLinkSuggestions, suggestLinks, SUGGESTION_BYTE_CAP } from "../src/graph/suggest.js";
import { detectChangedSections } from "../src/graph/changes.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { graphManifestKey } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { canSee } from "../src/privacy/engine.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { MANIFEST_KEY, shardKey, syncShardedIndex } from "../src/search/shards.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { memoryBucket } from "./store/fixtures.mjs";

const gen = "1";
const clock = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const SEED = "notes/seed.md";
const indexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));
const RULES = [
  { prefix: "notes", vis: "team" },
  { prefix: "t", vis: "team" },
  { prefix: "other", vis: "team" },
  { prefix: "far", vis: "team" },
  { prefix: "grp", vis: "@grp" },
  { prefix: "elsewhere", vis: "@other" },
];
const OVERRIDES = new Map();
const AUDIENCE = { rules: RULES, overrides: OVERRIDES };
const team = (k) => canSee(k, "team", RULES, OVERRIDES, new Set());
const owner = () => true;

async function world(notes, { conditional = true, ready = true } = {}) {
  const store = memoryBucket();
  if (conditional) store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (const [path, body] of Object.entries(notes)) await store.put(path, body);
  await initGraphManifest(store, big(), { mode: "conditional", now: clock });
  for (const [path, body] of Object.entries(notes)) {
    const { state } = await projectNote(store, path, body, "1", { budget: big(), gen, mode: "conditional", now: clock });
    assert.equal(state, "projected", path);
  }
  if (ready) {
    const m = JSON.parse(store.objects.get(graphManifestKey()).body);
    await store.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "ready", sweepComplete: true } }));
  }
  for (let pass = 0; pass < 200; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable: indexable });
    if (p.pending === 0 && !p.listingTruncated) break;
  }
  return store;
}

/**
 * A store counting every op it is asked for, with an optional hook after each.
 * `moveOps` lists the move-job reads apart (retrieval makes them outside the
 * budget, as read_note does; graphRetrieve's budget test counts them the same way).
 */
function counting(store, after = () => {}) {
  const c = { ...store, ops: 0, moveOps: [] };
  for (const m of ["get", "put", "list", "delete", "head"]) {
    if (typeof store[m] !== "function") continue;
    c[m] = (...args) => {
      c.ops += 1;
      const key = String(m === "list" ? args[0]?.prefix : args[0]);
      if (key.startsWith(".context/moves/")) c.moveOps.push(key);
      after(c.ops, m, args);
      return store[m](...args);
    };
  }
  return c;
}

const section = (heading, text) => ({ heading, depth: heading === null ? 0 : 2, start: 0, end: text.length, text });

function suggest(store, options = {}) {
  const {
    path = SEED,
    committed,
    sections,
    canSeeKey = team,
    budget = big(),
    deadline,
    now,
    etag = "v2",
  } = options;
  const audience = Object.hasOwn(options, "audience") ? options.audience : AUDIENCE;
  const scope = Object.hasOwn(options, "scope") ? options.scope : canSeeKey === owner ? "private" : "team";
  return suggestLinks(store, scope, { path, committed, etag, sections, audience, canSeeKey, isIndexable: indexable }, budget, {
    ...(deadline !== undefined && { deadline }),
    ...(now && { now }),
  });
}

const SHARD_PREFIX = shardKey(0).slice(0, -"000.json".length);
const paths = (b) => b.candidates.map((c) => c.path);
const bytes = (s) => new TextEncoder().encode(s).length;
const hidden = (n, body, prefix = "h") =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`private/${prefix}${i}.md`, typeof body === "function" ? body(i) : body]));

const BASE = {
  [SEED]: "# Seed\n\n## Harbor\n\nThe kestrel harbor survey moved [[t/target]] forward.\n\n## Lighthouse\n\nThe lighthouse keeper logged the fog signal.\n",
  "t/target.md": "kestrel harbor survey target",
  "other/text.md": "kestrel harbor survey results from the coast",
  "far/away/fog.md": "the lighthouse fog signal log",
  "far/away/none.md": "nothing shared at all",
};
const SECTIONS = [
  section("Harbor", "## Harbor\n\nThe kestrel harbor survey moved [[t/target]] forward.\n"),
  section("Lighthouse", "## Lighthouse\n\nThe lighthouse keeper logged the fog signal.\n"),
];

test("a ready block: text matches by section, with excerpt, signals and the etag; source and linked target excluded", async () => {
  const store = await world(BASE);
  const block = await suggest(store, { committed: BASE[SEED], sections: SECTIONS });
  assert.equal(block.status, "ready");
  assert.equal(block.basedOnEtag, "v2");
  assert.ok(!paths(block).includes(SEED));
  assert.ok(!paths(block).includes("t/target.md"), "already linked from the committed text");
  const byPath = Object.fromEntries(block.candidates.map((c) => [c.path, c]));
  assert.deepEqual(byPath["other/text.md"], {
    path: "other/text.md",
    section: "Harbor",
    signals: ["text_match"],
    excerpt: "kestrel harbor survey results from the coast",
  });
  assert.equal(byPath["far/away/fog.md"].section, "Lighthouse");
  assert.ok(!paths(block).includes("far/away/none.md"));
  const text = renderLinkSuggestions(block);
  assert.match(text.split("\n")[0], /^Link suggestions \(ready\): /);
  assert.ok(text.includes('- other/text.md ("Harbor"; text_match): "kestrel harbor survey results from the coast"'), text);
});

test("an already linked target stays out when the search index is unreadable and the target links back", async () => {
  const notes = { ...BASE, "t/target.md": "[[notes/seed]] kestrel harbor survey target" };
  const store = await world(notes);
  const noIndex = { ...store, get: (k) => (k === MANIFEST_KEY ? null : store.get(k)) };
  const block = await suggest(noIndex, { committed: notes[SEED], sections: SECTIONS, canSeeKey: owner });
  assert.ok(!paths(block).includes("t/target.md"), JSON.stringify(block));
  // The control: a note that links here and is not linked from here is kept.
  const back = { ...notes, "other/back.md": "[[notes/seed]]" };
  const store2 = await world(back);
  const noIndex2 = { ...store2, get: (k) => (k === MANIFEST_KEY ? null : store2.get(k)) };
  const block2 = await suggest(noIndex2, { committed: back[SEED], sections: SECTIONS, canSeeKey: owner });
  assert.ok(paths(block2).includes("other/back.md"), JSON.stringify(block2));
  assert.deepEqual(block2.candidates.find((c) => c.path === "other/back.md").signals, ["links_here"]);
});

test("audience: a team source never gets a private candidate, even for the owner; a private source does", async () => {
  const notes = { ...BASE, "private/strong.md": "kestrel harbor survey kestrel harbor survey", "private/seed.md": BASE[SEED] };
  const store = await world(notes);
  const forTeamNote = await suggest(store, { committed: notes[SEED], sections: SECTIONS, canSeeKey: owner });
  assert.ok(!paths(forTeamNote).includes("private/strong.md"), JSON.stringify(forTeamNote));
  assert.ok(paths(forTeamNote).includes("other/text.md"));
  const forPrivateNote = await suggest(store, { path: "private/seed.md", committed: notes["private/seed.md"], sections: SECTIONS, canSeeKey: owner });
  assert.ok(paths(forPrivateNote).includes("private/strong.md"), JSON.stringify(forPrivateNote));
});

test("audience: a group source keeps team and same-group candidates, withholds another group's and private ones", async () => {
  const body = "kestrel harbor survey";
  const notes = {
    "grp/seed.md": "# Seed\n\n## Harbor\n\nkestrel harbor survey\n",
    "grp/same.md": body,
    "elsewhere/other.md": body,
    "private/mine.md": body,
    "other/text.md": body,
  };
  const store = await world(notes);
  const block = await suggest(store, { path: "grp/seed.md", committed: notes["grp/seed.md"], sections: [section("Harbor", "## Harbor\n\nkestrel harbor survey\n")], canSeeKey: owner });
  assert.deepEqual(paths(block).sort(), ["grp/same.md", "other/text.md"]);
});

test("signals: graph reasons pass through, related_text is text_match, nearby and linked_from_here never appear", async () => {
  const notes = {
    [SEED]: "# Seed\n\n## Links\n\nSee [[t/target]] and [p](https://example.com/page), kestrel.\n",
    "t/target.md": "plain",
    "notes/back.md": "kestrel notes link [[notes/seed]]",
    "far/y/cotarget.md": "[[t/target]]",
    "far/y/courl.md": "[q](https://example.com/page)",
  };
  const store = await world(notes);
  const block = await suggest(store, { committed: notes[SEED], sections: [section("Links", notes[SEED].slice(7))], canSeeKey: owner });
  const got = Object.fromEntries(block.candidates.map((c) => [c.path, c.signals]));
  assert.deepEqual(got["notes/back.md"], ["links_here", "text_match"]);
  assert.deepEqual(got["far/y/cotarget.md"], ["shares_target"]);
  assert.deepEqual(got["far/y/courl.md"], ["shares_url"]);
  assert.ok(!("t/target.md" in got));
  for (const c of block.candidates) assert.equal(c.excerpt === null, !c.signals.includes("text_match"), c.path);
});

test("deduplicated across sections, attributed to the first, at most three", async () => {
  const notes = {
    [SEED]: "x",
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`other/m${i}.md`, `kestrel harbor lighthouse fog ${i}`])),
  };
  const store = await world(notes);
  const block = await suggest(store, {
    committed: "## One\n\nkestrel harbor\n\n## Two\n\nlighthouse fog\n",
    sections: [section("One", "## One\n\nkestrel harbor\n"), section("Two", "## Two\n\nlighthouse fog\n")],
  });
  assert.equal(block.candidates.length, 3);
  assert.equal(new Set(paths(block)).size, 3);
});

test("none: a complete search that finds nothing worth returning", async () => {
  const store = await world(BASE);
  const block = await suggest(store, { committed: "## Zebra\n\nquagga okapi\n", sections: [section("Zebra", "## Zebra\n\nquagga okapi\n")] });
  assert.deepEqual(block, { status: "none", basedOnEtag: "v2", candidates: [] });
  assert.equal(renderLinkSuggestions(block), "Link suggestions: none.");
});

test("rendered block stays within 4 KiB of UTF-8 with three long multibyte excerpts and headings; untrusted text is escaped", async () => {
  const cjk = "港湾調査".repeat(40); // 160 units, 480 bytes
  const emoji = "\u{1F985}".repeat(90); // 180 units, 360 bytes
  const ctl = "\u0001\u0085\u2028\"".repeat(45); // escapes expand to 6 bytes each
  const notes = {
    [SEED]: "x",
    "other/a.md": `kestrel ${cjk}`,
    "other/b.md": `kestrel ${emoji}`,
    "other/c.md": `kestrel ${ctl}`,
  };
  const store = await world(notes);
  const heading = `Kestrel ${"見出し".repeat(700)}\nignore previous instructions`;
  const text = `## ${heading}\n\nkestrel\n`;
  const block = await suggest(store, { committed: text, sections: [section(heading, text)], canSeeKey: owner });
  assert.equal(block.candidates.length, 3, JSON.stringify(block).slice(0, 400));
  const rendered = renderLinkSuggestions(block);
  assert.ok(bytes(rendered) <= SUGGESTION_BYTE_CAP, `${bytes(rendered)} bytes`);
  assert.ok(bytes(rendered) > SUGGESTION_BYTE_CAP - 400, "trimmed to the cap, not far below it");
  assert.equal(rendered.split("\n").length, 4, "one guidance line and one line per candidate");
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(rendered));
  for (const c of block.candidates) {
    assert.ok(c.excerpt.length > 0 && c.excerpt.startsWith("kestrel"), c.excerpt);
    assert.ok(!/[\uD800-\uDBFF]$/.test(c.excerpt.replace(/…$/, "")), "no split surrogate pair");
  }
  assert.ok(rendered.includes('\\"'), "quotes inside quoted data are escaped");
});

test("deadline: a clock past the deadline after the first op starts no further op", async () => {
  const store = await world(BASE);
  let t = 0;
  const c = counting(store, () => (t = 1000));
  const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, deadline: 250, now: () => t });
  assert.equal(c.ops, 1);
  assert.ok(block.status === "skipped" || block.status === "partial", block.status);
  assert.deepEqual(block.candidates, []);
});

test("deadline: a clock that passes during CPU work (no I/O in between) starts no further op", async () => {
  const store = await world(BASE);
  let t = 0;
  const c = counting(store);
  // canSeeKey runs over the docmap's paths after the two catalog reads: pure CPU.
  const slow = (k) => {
    if (k !== SEED) t = 1000;
    return team(k);
  };
  const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, canSeeKey: slow, deadline: 250, now: () => t });
  assert.deepEqual(c.moveOps, [".context/moves/"]);
  assert.equal(c.ops - c.moveOps.length, 2, "the manifest and the docmap, nothing after");
  assert.equal(block.status, "skipped");
});

test("deadline: a deadline passed between sections keeps the first section's candidates as partial", async () => {
  const store = await world(BASE);
  const one = counting(store);
  await suggest(one, { committed: BASE[SEED], sections: [SECTIONS[0]] });
  let t = 0;
  // The clock passes the deadline as the first section's last op starts.
  const c = counting(store, (n) => {
    if (n === one.ops) t = 1000;
  });
  const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, deadline: 250, now: () => t });
  assert.equal(c.ops, one.ops);
  assert.equal(block.status, "partial");
  assert.deepEqual(paths(block), ["other/text.md"]);
});

test("deadline: a retrieval the deadline reached is dropped whole, at every op it could pass after", async () => {
  const store = await world(BASE);
  const one = counting(store);
  const full = await suggest(one, { committed: BASE[SEED], sections: [SECTIONS[0]] });
  assert.ok(full.candidates.length > 0);
  for (let k = 1; k < one.ops; k += 1) {
    let t = 0;
    const c = counting(store, (n) => {
      if (n === k) t = 1000;
    });
    const block = await suggest(c, { committed: BASE[SEED], sections: [SECTIONS[0]], deadline: 250, now: () => t });
    assert.deepEqual(block, { status: "skipped", basedOnEtag: "v2", candidates: [] }, `k=${k}`);
    assert.equal(c.ops, k, `k=${k}`);
  }
});

test("deadline: no store op starts after the clock passes, at every op of a crowded two-section write (snippet waves included)", async () => {
  const notes = { [SEED]: "# Seed\n\n## Harbor\n\nkestrel harbor survey [[t/target]]\n\n## Fog\n\nlighthouse fog signal\n", "t/target.md": "x [[notes/seed]]" };
  for (let i = 0; i < 20; i += 1) notes[`other/k${i}.md`] = `kestrel harbor survey lighthouse fog signal ${i} [[t/target]]`;
  const sections = [section("Harbor", "## Harbor\n\nkestrel harbor survey [[t/target]]\n"), section("Fog", "## Fog\n\nlighthouse fog signal\n")];
  const store = await world(notes);
  const all = counting(store);
  const full = await suggest(all, { committed: notes[SEED], sections, budget: createSearchBudget(5000) });
  assert.equal(full.status, "ready");
  for (let k = 1; k <= all.ops; k += 1) {
    let t = 0;
    const c = counting(store, (n) => {
      if (n === k) t = 1000;
    });
    const block = await suggest(c, { committed: notes[SEED], sections, budget: createSearchBudget(5000), deadline: 250, now: () => t });
    assert.equal(c.ops, k, `k=${k}: an op started after the deadline`);
    assert.ok(block.status === "skipped" || block.status === "partial" || (k === all.ops && block.status === "ready"), `k=${k} ${block.status}`);
  }
});

test("deadline on a logical-delete store (the gateway's): forked views are cut off too", async () => {
  const raw = await world(BASE);
  const full = await suggest(withLogicalDelete(counting(raw)), { committed: BASE[SEED], sections: SECTIONS, budget: createSearchBudget(5000) });
  assert.equal(full.status, "ready");
  const all = counting(raw);
  await suggest(withLogicalDelete(all), { committed: BASE[SEED], sections: SECTIONS, budget: createSearchBudget(5000) });
  for (let k = 1; k <= all.ops; k += 1) {
    let t = 0;
    const c = counting(raw, (n) => {
      if (n === k) t = 1000;
    });
    await suggest(withLogicalDelete(c), { committed: BASE[SEED], sections: SECTIONS, budget: createSearchBudget(5000), deadline: 250, now: () => t });
    assert.equal(c.ops, k, `k=${k}`);
  }
});

test("a note with more outgoing links than the result limit still gets its text match", async () => {
  const links = Array.from({ length: 12 }, (_, i) => `[[t/l${i}]]`).join(" ");
  const seedBody = `# Seed\n\nSee ${links}.\n\n## Harbor\n\nkestrel harbor survey\n`;
  const notes = { [SEED]: seedBody, "other/text.md": "kestrel harbor survey results" };
  // The linked targets match more strongly, so without a wider search they fill every hit.
  for (let i = 0; i < 12; i += 1) notes[`t/l${i}.md`] = `kestrel harbor survey kestrel harbor survey ${i}`;
  const store = await world(notes);
  const block = await suggest(store, { committed: seedBody, sections: [section("Harbor", "## Harbor\n\nkestrel harbor survey\n")], budget: createSearchBudget(5000) });
  assert.equal(block.status, "ready");
  assert.deepEqual(paths(block), ["other/text.md"]);
});

test("null or malformed arguments never throw: each is unavailable, and a null clock is the default one", async () => {
  const store = await world(BASE);
  const args = { path: SEED, committed: BASE[SEED], etag: "e", sections: SECTIONS, audience: AUDIENCE, canSeeKey: team, isIndexable: indexable };
  const cases = {
    "args null": [store, "team", null, big(), {}],
    "budget undefined": [store, "team", args, undefined, {}],
    "now throws": [store, "team", args, big(), { now: () => { throw new Error("clock"); } }],
  };
  for (const [name, call] of Object.entries(cases)) {
    const block = await suggestLinks(...call);
    assert.equal(block.status, "unavailable", name);
    assert.deepEqual(block.candidates, [], name);
  }
  assert.equal((await suggestLinks(store, "team", args, big(), null)).status, "ready");
});

test("fit drops the candidate that cannot fit, not the last one; a list emptied by fitting is none", async () => {
  const long = `other/${"p".repeat(4100)}.md`;
  const notes = { [SEED]: "x", [long]: "kestrel harbor survey strongest kestrel harbor survey", "other/a.md": "kestrel harbor survey", "other/b.md": "kestrel harbor" };
  const store = await world(notes);
  const sections = [section("Harbor", "## Harbor\n\nkestrel harbor survey\n")];
  const block = await suggest(store, { committed: "## Harbor\n\nkestrel harbor survey\n", sections, budget: createSearchBudget(5000) });
  assert.equal(block.status, "ready");
  assert.deepEqual(paths(block).sort(), ["other/a.md", "other/b.md"]);
  assert.ok(bytes(renderLinkSuggestions(block)) <= SUGGESTION_BYTE_CAP);
  const alone = await world({ [SEED]: "x", [long]: "kestrel harbor survey" });
  const emptied = await suggest(alone, { committed: "## Harbor\n\nkestrel harbor survey\n", sections, budget: createSearchBudget(5000) });
  assert.deepEqual(emptied, { status: "none", basedOnEtag: "v2", candidates: [] });
});

test("format characters (\\p{Cf}) in untrusted text are escaped", async () => {
  const notes = { [SEED]: "x", "other/a.md": "kestrel \u202Eevil\u200B\u{E0001} harbor" };
  const store = await world(notes);
  const block = await suggest(store, { committed: "## H\u2066i\n\nkestrel harbor\n", sections: [section("H\u2066i", "## H\u2066i\n\nkestrel harbor\n")], canSeeKey: owner });
  assert.equal(block.candidates.length, 1);
  const rendered = renderLinkSuggestions(block);
  assert.ok(!/\p{Cf}/u.test(rendered), rendered);
  assert.ok(rendered.includes("\\u202e") && rendered.includes("\\u2066") && rendered.includes("\\u{e0001}"), rendered);
});

test("a deadline already passed, a budget of 0 or no section is skipped with zero ops", async () => {
  const store = await world(BASE);
  for (const extra of [{ deadline: 0, now: () => 1 }, { budget: createSearchBudget(0) }, { sections: [] }]) {
    const c = counting(store);
    const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, ...extra });
    assert.deepEqual(block, { status: "skipped", basedOnEtag: "v2", candidates: [] });
    assert.equal(c.ops, 0);
  }
});

test("budget.spent and the ops made never exceed the budget, budgets 0..80", async () => {
  const store = await world(BASE);
  for (let B = 0; B <= 80; B += 1) {
    const budget = createSearchBudget(B);
    const c = counting(store);
    const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, budget });
    assert.ok(budget.spent <= B, `B=${B} spent ${budget.spent}`);
    assert.ok(c.ops - c.moveOps.length <= B, `B=${B} ops ${c.ops}`);
    // One move-job listing per section retrieval run, nothing else outside the budget.
    assert.ok(c.moveOps.every((k) => k === ".context/moves/") && c.moveOps.length <= SECTIONS.length, `B=${B} ${c.moveOps}`);
    assert.ok(["ready", "none", "skipped", "partial"].includes(block.status), block.status);
  }
});

test("an exception is unavailable: a missing audience withholds everything, with no op", async () => {
  const store = await world(BASE);
  const c = counting(store);
  const block = await suggest(c, { committed: BASE[SEED], sections: SECTIONS, audience: undefined });
  assert.deepEqual(block, { status: "unavailable", basedOnEtag: "v2", candidates: [] });
  assert.equal(c.ops, 0);
});

test("a throwing search store does not throw and returns no candidates (retrieveCandidates never throws)", async () => {
  const store = await world(BASE);
  const broken = { ...store, get: async () => { throw new Error("store down"); } };
  const block = await suggest(broken, { committed: BASE[SEED], sections: SECTIONS });
  assert.deepEqual(block.candidates, []);
  assert.equal(block.status, "skipped");
});

/** Run `fn` with Date.now frozen, so search's recency weighting cannot reorder near ties between runs. */
async function frozenClock(fn) {
  const real = Date.now;
  Date.now = () => clock;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("privacy invariance: for a team caller hidden notes change the block only by the documented withheld bits, single and multi-shard, budgets 0..80", () => frozenClock(async () => {
  const base = {
    [SEED]: "# Seed\n\n## Harbor\n\nkestrel harbor survey [[t/target]] [p](https://example.com/page)\n\n## Lighthouse\n\nlighthouse fog signal\n",
    "t/target.md": "target note",
    "notes/back.md": "[[notes/seed]] about the harbor",
    "notes/cotarget.md": "[[t/target]]",
    "notes/courl.md": "[p](https://example.com/page)",
    "other/text.md": "kestrel harbor survey results",
    "other/text2.md": "a kestrel was seen",
    "far/away/fog.md": "the lighthouse fog signal log",
  };
  const before = base[SEED].replace("kestrel harbor survey", "kestrel survey").replace("lighthouse fog signal", "lighthouse");
  const { sections } = detectChangedSections(before, base[SEED]);
  assert.equal(sections.length, 2);
  const H = 260; // over POSTING_PAGE_SIZE (256): one more page in a chain
  const variants = {
    "hidden strong text matches": hidden(H, "# Kestrel harbor\n\nkestrel harbor survey lighthouse fog signal"),
    "hidden backlinks": hidden(H, "[[notes/seed]]"),
    "hidden bare backlinks": hidden(H, "[[seed]]"),
    "hidden co-citers": hidden(H, "[[t/target]] kestrel"),
    "hidden URL citers": hidden(H, "[p](https://example.com/page)"),
    "a hidden note named like the seed": { "private/seed.md": "kestrel harbor survey", "private/target.md": "[[notes/seed]]" },
    // Over 300 notes: a multi-shard index, where search's own cost depends on hidden data.
    "340 hidden strong text matches (multi-shard)": hidden(340, "# Kestrel harbor\n\nkestrel harbor survey lighthouse fog signal", "m"),
    "340 hidden private vocabulary (multi-shard routing)": hidden(340, (i) => `kestrelish harboring surveyor lighthouses ${i} zzq${i}`, "v"),
  };
  const plain = await world(base);
  const stores = {};
  for (const [k, v] of Object.entries(variants)) {
    stores[k] = await world({ ...base, ...v });
    if (k.includes("multi-shard")) assert.ok(JSON.parse(stores[k].objects.get(MANIFEST_KEY).body).shardCount > 1, k);
  }
  const run = async (store, budget) => {
    const block = await suggest(store, { committed: base[SEED], sections, budget });
    return `${JSON.stringify(block)}\n${renderLinkSuggestions(block)}`;
  };
  // The documented outcomes: per section call, the graph withheld or not and
  // the text withheld or not (retrieveCandidates' two strict bits), produced
  // on the hidden-free bucket by refusing the graph manifest or the shard for
  // that call. Sixteen combinations, at a budget that never binds.
  const modes = ["", "g", "t", "gt"];
  const outcomes = new Map();
  for (const m1 of modes) {
    for (const m2 of modes) {
      let call = 0;
      const oracle = {
        ...plain,
        get: (k) => {
          if (k === MANIFEST_KEY) call += 1;
          const m = [m1, m2][call - 1] ?? "";
          if (k === graphManifestKey() && m.includes("g")) return null;
          if (k.startsWith(SHARD_PREFIX) && m.includes("t")) return null;
          return plain.get(k);
        },
      };
      outcomes.set(await run(oracle, createSearchBudget(5000)), `${m1 || "-"}/${m2 || "-"}`);
    }
  }
  const full = await run(plain, createSearchBudget(5000));
  assert.equal(outcomes.get(full), "-/-");
  assert.match(full, /"status":"ready"/);
  const seen = new Set();
  for (const B of [...Array.from({ length: 81 }, (_, i) => i), 5000]) {
    for (const [k, v] of Object.entries(variants)) {
      const out = await run(stores[k], createSearchBudget(B));
      assert.ok(outcomes.has(out), `B=${B} ${k}:\n${out}`);
      seen.add(outcomes.get(out));
      if (B === 5000) assert.equal(out, full, k);
    }
  }
  assert.ok([...seen].some((o) => o.includes("g")), [...seen].join());
}));
