/**
 * Index-assisted referrer lookup in `rewriteReferences` (Task 14, arch 11.1,
 * OPEN-23, OPEN-24, OPEN-25). With a complete graph, a move reads only the
 * moved notes, the sources the postings name and every note changed since the
 * sweep's census (the top-up); anything less certain scans. The rewritten
 * bodies, the audit row and the returned counts must match the scan's.
 *
 * Listing times come from a test clock (`timed`): memoryBucket stamps every
 * listed object with the wall clock, which would put every note in the top-up.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   skip the `uploaded` top-up                                  2 (edited after the sweep,
 *                                                                 reverseRepair)
 *   accept a `complete: false` posting read                     2 (truncated chain, budget)
 *   drop the `.md` check on renamed paths                       1 (attachment)
 *   ignore active logical move jobs                             1 (move job)
 *   return the candidate set unfiltered and unordered, with     4 (team caller, and single,
 *   posting sources unfiltered by `canSee`                        batch, folder: audit order)
 *
 * In graphCoverage.test.mjs, a cutover publishing no census time fails the
 * rebuild cutover test there (1).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { rewriteReferences } from "../src/tools/moves/references.js";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphHealth } from "../src/graph/manifest.js";
import { readPostings } from "../src/graph/postings.js";
import { graphManifestKey, nameHash, nodeKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { moveJobKey } from "../src/moves/jobs.js";
import { MOVE_JOB_VERSION } from "../src/moves/limits.js";
import { memoryBucket } from "./store/fixtures.mjs";

const MIN = 60_000;
const SEEDED = Date.UTC(2026, 0, 1);
const COVER = SEEDED + 60 * MIN; // the census the sweep started on
const LATER = COVER + 5 * MIN; // edits and moves after the sweep
const big = () => createSearchBudget(100000);
const OWNER = { scope: "private", rules: [], overrides: new PrivacyOverrides() };
const TEAM = { scope: "team", rules: [{ prefix: "team", vis: "team" }], overrides: new PrivacyOverrides() };

/**
 * A memoryBucket whose listing reports each key's last write on a test clock,
 * and which records every key read.
 */
function timed({ bestEffort = false } = {}) {
  const b = memoryBucket(bestEffort ? { ignoreIfMatch: true } : {});
  b.capabilities = bestEffort ? {} : { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  const times = new Map();
  let clock = SEEDED;
  const { put, list, get } = b;
  b.put = async (key, value, options) => {
    const done = await put(key, value, options);
    if (done) times.set(key, clock);
    return done;
  };
  b.list = async (options) => {
    const listed = await list(options);
    for (const o of listed.objects) o.uploaded = new Date(times.get(o.key) ?? SEEDED);
    return listed;
  };
  b.reads = [];
  b.get = async (key) => {
    b.reads.push(key);
    return get(key);
  };
  b.at = (t) => {
    clock = t;
  };
  b.times = times;
  return b;
}

const isNote = (key) => key.endsWith(".md") && !key.startsWith(".");
/** Distinct note bodies read (collaboration reads a note more than once). */
const bodyReads = (b) => [...new Set(b.reads.filter(isNote))];
const graphRecordReads = (b) => b.reads.filter((k) => /\/(nodes|incoming|bare|names|urls)\//.test(k));
const censusOf = (b) => {
  const census = new Map();
  for (const [key, { etag }] of b.objects) if (defaultIsIndexable(key)) census.set(key, etag);
  return census;
};

/** Sweep until the graph reports complete (at most ten passes), on the COVER census. */
async function index(b) {
  for (let i = 0; i < 10; i += 1) {
    await reconcileGraph(b, big(), {
      census: censusOf(b), censusComplete: true, censusListedAt: new Date(COVER).toISOString(),
      isIndexable: defaultIsIndexable, now: COVER,
    });
    if ((await graphHealth(b, big())).complete) return;
  }
}

/** The bucket after the moves: each `from` body lands at `to` and `from` is gone. */
async function move(b, renames) {
  for (const [from, to] of renames) {
    await b.put(to, b.objects.get(from).body);
    b.objects.delete(from);
    b.times.delete(from);
  }
}

async function build(notes, { bestEffort = false, scan = false } = {}) {
  const b = timed({ bestEffort });
  for (const [key, body] of Object.entries(notes)) await b.put(key, body);
  await index(b);
  if (scan) b.objects.delete(graphManifestKey());
  b.at(LATER);
  return b;
}

async function run(b, renames, who = OWNER) {
  await move(b, renames);
  b.reads.length = 0;
  return rewriteReferences(b, who.scope, who.rules, who.overrides, renames);
}

const notesOf = (b) =>
  Object.fromEntries([...b.objects].filter(([k]) => isNote(k) && k !== "activity.md").map(([k, v]) => [k, v.body]));
const auditRow = (b) => {
  const rows = [...b.objects.keys()].filter((k) => k.startsWith(".context/audit/")).map((k) => JSON.parse(b.objects.get(k).body));
  const row = rows.find((r) => r.action === "rewrite_references");
  return row ? { paths: row.paths, details: row.details } : null;
};

/** Same fixture, once on the index and once with the manifest removed. */
async function same(notes, renames, who = OWNER) {
  const indexed = await build(notes);
  assert.equal((await graphHealth(indexed, big())).complete, true, "fixture graph is complete");
  const scanned = await build(notes, { scan: true });
  const a = await run(indexed, renames, who);
  const s = await run(scanned, renames, who);
  assert.deepEqual(a, s);
  assert.deepEqual(notesOf(indexed), notesOf(scanned));
  assert.deepEqual(auditRow(indexed), auditRow(scanned));
  assert.ok(a.links > 0, "the fixture rewrites something");
  return { indexed, scanned, a };
}

function unrelated(n, prefix = "u") {
  const out = {};
  for (let i = 0; i < n; i += 1) out[`${prefix}${String(i).padStart(3, "0")}.md`] = `# U${i}\n[next](./${prefix}${String(i + 1).padStart(3, "0")}.md)`;
  return out;
}

const NOTES = {
  "a/t.md": "# T\nback to [r1](../r1.md) and [[s]]",
  "a/s.md": "# S\n[t](./t.md) and [out](../b/r3.md)",
  "r1.md": "see [t](./a/t.md)",
  "r2.md": "bare [[t]] here",
  "b/r3.md": "rooted [[a/t]] and [s](../a/s.md)",
  "b/r4.md": "inline [s](/a/s.md) only",
  ...unrelated(12),
};

test("single move: same bodies, audit row and counts as the scan, with fewer body reads", async () => {
  const { indexed, scanned } = await same(NOTES, new Map([["a/t.md", "c/t2.md"]]));
  assert.ok(bodyReads(indexed).length < bodyReads(scanned).length, `${bodyReads(indexed).length} vs ${bodyReads(scanned).length}`);
  assert.ok(!bodyReads(indexed).includes("u005.md"));
});

test("batch move: same result as the scan", async () => {
  const { indexed, scanned } = await same(NOTES, new Map([["a/t.md", "c/t.md"], ["b/r4.md", "d/r4.md"]]));
  assert.ok(bodyReads(indexed).length < bodyReads(scanned).length);
});

test("folder move: same result as the scan", async () => {
  const { indexed, scanned } = await same(NOTES, new Map([["a/t.md", "z/t.md"], ["a/s.md", "z/s.md"]]));
  assert.ok(bodyReads(indexed).length < bodyReads(scanned).length);
});

test("move_note gets the index through rewriteReferences", async () => {
  const b = await build(NOTES);
  b.reads.length = 0;
  const out = await toolMoveNote(b, OWNER.scope, OWNER.rules, OWNER.overrides, "a/t.md", "c/t2.md");
  assert.ok(!out.isError, JSON.stringify(out));
  assert.match(b.objects.get("r1.md").body, /\.\/c\/t2\.md/);
  assert.ok(!bodyReads(b).includes("u005.md"));
});

test("a graph that is not ready falls back to the scan and still rewrites everything", async () => {
  const b = await build(NOTES);
  const m = JSON.parse(b.objects.get(graphManifestKey()).body);
  await b.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "behind" } }));
  const out = await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.ok(bodyReads(b).includes("u005.md"));
  assert.match(b.objects.get("r1.md").body, /\.\/c\/t2\.md/);
  assert.ok(out.links > 0);
});

test("a truncated posting chain falls back to the scan", async () => {
  const b = await build(NOTES);
  const gen = (await graphHealth(b, big())).generation;
  const key = postingPageKey(gen, "incoming", await pathHash("a/t.md"), 0);
  const page = JSON.parse(b.objects.get(key).body);
  // A `next` that is not page + 1: the walk stops as malformed.
  await b.put(key, JSON.stringify({ ...page, next: "7" }));
  const read = await readPostings(b, big(), { gen, family: "incoming", hash: await pathHash("a/t.md"), canSee: () => true, validate: () => true });
  assert.equal(read.complete, false);
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.ok(bodyReads(b).includes("u005.md"));
  assert.match(b.objects.get("r1.md").body, /\.\/c\/t2\.md/);
});

test("a best-effort store always scans and reads no node or posting", async () => {
  const b = await build(NOTES, { bestEffort: true });
  assert.equal((await graphHealth(b, big())).complete, false);
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.deepEqual(graphRecordReads(b), []);
  assert.ok(bodyReads(b).includes("u005.md"));
  assert.match(b.objects.get("r1.md").body, /\.\/c\/t2\.md/);
});

test("a note edited after the sweep and never projected is rewritten via the top-up", async () => {
  const b = await build(NOTES);
  await b.put("u004.md", "now links [t](./a/t.md)"); // at LATER, no projection
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.equal(b.objects.get("u004.md").body, "now links [t](./c/t2.md)");
  assert.ok(!bodyReads(b).includes("u005.md"), "the index path ran");
});

test("a node still owing reverseRepair, edited inside the margin, is read like the scan would", async () => {
  const b = await build(NOTES);
  const gen = (await graphHealth(b, big())).generation;
  // A same-note race (Task 7): the source's newest record owes its repair and
  // the target's posting does not name it yet. Its write landed two minutes
  // before the census the sweep started on.
  b.at(COVER - 2 * MIN);
  await b.put("u006.md", "raced [[t]]");
  const nk = nodeKey(gen, await pathHash("u006.md"));
  const node = JSON.parse(b.objects.get(nk).body);
  await b.put(nk, JSON.stringify({ ...node, reverseRepair: [{ family: "bare", hash: await nameHash("t") }] }));
  b.at(LATER);
  const read = await readPostings(b, big(), { gen, family: "bare", hash: await nameHash("t"), canSee: () => true, validate: () => true });
  assert.ok(!read.entries.some((e) => e.source === "u006.md"), "fixture: posting lacks the racing source");
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.equal(b.objects.get("u006.md").body, "raced [[t2]]");
  assert.ok(bodyReads(b).includes("u006.md"));
  assert.ok(!bodyReads(b).includes("u005.md"), "a clean note outside the margin is not read");
});

test("a budget too small for the posting reads scans", async () => {
  const b = await build(NOTES);
  b.searchSubrequestBudget = 1; // the manifest read takes it; the first walk is refused
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.ok(bodyReads(b).includes("u005.md"));
  assert.match(b.objects.get("r1.md").body, /\.\/c\/t2\.md/);
});

test("a folder move that includes an attachment scans", async () => {
  const b = await build({ ...NOTES, "a/pic.png": "png" });
  await run(b, new Map([["a/t.md", "z/t.md"], ["a/pic.png", "z/pic.png"]]));
  assert.deepEqual(graphRecordReads(b), []);
  assert.ok(bodyReads(b).includes("u005.md"));
});

test("an active logical move job scans", async () => {
  const b = await build(NOTES);
  const id = "job-0000000000001";
  await b.put(moveJobKey(id), JSON.stringify({
    version: MOVE_JOB_VERSION, id, source: "x", destination: "y", objects: [], status: "logical_active",
  }));
  await run(b, new Map([["a/t.md", "c/t2.md"]]));
  assert.ok(bodyReads(b).includes("u005.md"));
});

test("a team caller's move never reads a hidden referrer the postings name, and counts match the scan", async () => {
  const notes = {
    "team/t.md": "# T",
    "team/r.md": "[t](./t.md)",
    "secret/h.md": "hidden [t](../team/t.md)",
    ...unrelated(6, "team/u"),
  };
  const renames = new Map([["team/t.md", "team/t2.md"]]);
  const indexed = await build(notes);
  const gen = (await graphHealth(indexed, big())).generation;
  const read = await readPostings(indexed, big(), { gen, family: "incoming", hash: await pathHash("team/t.md"), canSee: () => true, validate: () => true });
  assert.ok(read.entries.some((e) => e.source === "secret/h.md"), "fixture: the postings name the hidden note");
  const scanned = await build(notes, { scan: true });
  const a = await run(indexed, renames, TEAM);
  const s = await run(scanned, renames, TEAM);
  assert.ok(!indexed.reads.includes("secret/h.md"));
  assert.ok(!indexed.reads.includes(nodeKey(gen, await pathHash("secret/h.md"))));
  assert.deepEqual(a, s);
  assert.deepEqual(notesOf(indexed), notesOf(scanned));
  assert.equal(indexed.objects.get("secret/h.md").body, "hidden [t](../team/t.md)");
  assert.ok(!bodyReads(indexed).includes("team/u003.md"), "the index path ran");
});

test("200 notes, 3 referrers: the index reads fewer note bodies than the scan", async (t) => {
  const notes = {
    "hub/t.md": "# T",
    "r/one.md": "[t](../hub/t.md)",
    "r/two.md": "[[t]]",
    "r/three.md": "[[hub/t]]",
    ...unrelated(196),
  };
  assert.equal(Object.keys(notes).length, 200);
  const { indexed, scanned, a } = await same(notes, new Map([["hub/t.md", "hub/moved.md"]]));
  const i = bodyReads(indexed).length;
  const s = bodyReads(scanned).length;
  t.diagnostic(`body reads: index ${i}, scan ${s}`);
  assert.equal(a.notes, 3);
  assert.ok(i <= 5, `index read ${i}`);
  assert.ok(s >= 200, `scan read ${s}`);
});
