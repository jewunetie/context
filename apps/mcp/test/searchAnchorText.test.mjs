/**
 * Anchor-text indexing (SEARCH_ANCHOR_TEXT, off by default).
 *
 * When note A links to note B, the link's display text (`[[B|alias]]`,
 * `[label](B.md)`) and A's title are recorded on the graph's posting entry for
 * B, and a v3 index built with the switch adds them to B's document as a fifth,
 * low-weight field. Covered here: the format switch, the graph record and
 * posting fields, the caps, the privacy rule at index time and the guard at
 * query time, bare-name uniqueness, freshness after an edit and a delete of A,
 * and progress at DEFERRED_SYNC_FLOOR. The switch-off pins are
 * searchV2Frozen.test.mjs and searchV3Frozen.test.mjs.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, against this file plus both
 * frozen pins. Counts are failing tests.
 *
 *   admission always true (admitsAnchor)                                 3 (admission table, collectAnchors, private source)
 *   query-time guard off (anchorsCount always true)                      1 (invariance after narrowing)
 *   bare name used without the uniqueness check                          1 (ambiguous name)
 *   switch on by default                                                 3 (format, end to end, v3 off pin)
 *   no refresh after a write (afterWrite.js)                             2 (write freshness, queued refresh)
 *   no refresh after reconciliation (maintenance.js)                     1 (delete freshness)
 *   refresh list not written to the manifest                             1 (queued refresh)
 *   graph manifest read whatever the budget                              1 (floor)
 *   anchor-only work counted as pending                                  1 (floor)
 *   unread anchors not marked                                            1 (floor)
 *   display texts left out of referenceSetVersion                        4 (both graph tests, both write refreshes)
 *   display text uncapped                                                1 (caps)
 *   sources per note uncapped                                            1 (collectAnchors)
 *   census keeps the unread mark (d1/backfill.js)                        1 (census)
 *   anchor field on every chunk                                          1 (chunks)
 *   encrypted target not skipped                                         1 (encrypted)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { indexFormatFor, formatsEqual, usesV3, DEFAULT_FORMAT } from "../src/search/format.js";
import { buildNodeRecord, membershipsFor, PARSER_VERSION } from "../src/graph/facts.js";
import { readPostings } from "../src/graph/postings.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { nameHash, pathHash } from "../src/graph/keys.js";
import { projectNote } from "../src/graph/project.js";
import { projectNoteAfterWrite } from "../src/graph/afterWrite.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex, loadIndexManifest } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { DEFERRED_SYNC_FLOOR } from "../src/search/pacing.js";
import {
  ANCHOR_SOURCES_PER_TARGET, ANCHOR_TEXT_CHARS, ANCHOR_TEXTS_PER_ENTRY, ANCHORS_UNREAD, admitsAnchor, collectAnchors,
} from "../src/search/anchors.js";
import { censusFromManifest } from "../src/search/d1/backfill.js";
import { canSee, effectiveVisibility } from "../src/privacy/engine.js";
import { r2LikeBucket } from "./store/fixtures.mjs";
import { DOCMAP_KEY, V3_DOCMAP_KEY } from "../src/search/shards/constants.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const ANCHORS = indexFormatFor({ SEARCH_TOKENIZER: "2", SEARCH_ANCHOR_TEXT: "1" });
const PLAIN = indexFormatFor({ SEARCH_TOKENIZER: "2" });
const isIndexable = (key) => key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));
const big = () => createSearchBudget(100000);

// ---------------------------------------------------------------- the switch

test("format: SEARCH_ANCHOR_TEXT=1 adds anchors to the format, anything else leaves it absent", () => {
  assert.equal(ANCHORS.anchors, true);
  assert.equal(usesV3(indexFormatFor({ SEARCH_ANCHOR_TEXT: "1" })), true, "tokenizer 1 with anchors is still a v3 index");
  assert.equal(formatsEqual(ANCHORS, PLAIN), false);
  for (const value of [undefined, "", "0", "true", "on", " 2", 1]) {
    assert.deepEqual(indexFormatFor({ SEARCH_ANCHOR_TEXT: value }), DEFAULT_FORMAT, String(value));
  }
  assert.equal("anchors" in PLAIN, false);
});

// ---------------------------------------------------------------- graph facts

test("graph: occurrences carry their display text, the record its title, and both feed referenceSetVersion", async () => {
  assert.equal(PARSER_VERSION, 3);
  const body = "# Kickoff notes\n\nSee [[Target|the codename]], [[Other]], [label text](sub/x.md) and ![[img.png]].\n";
  const { record } = await buildNodeRecord("a.md", body, "1", { now: NOW });
  assert.equal(record.title, "Kickoff notes");
  const texts = record.occurrences.map((o) => o.text ?? null);
  assert.deepEqual(texts, ["the codename", null, "label text", null]);
  const { anchors } = await membershipsFor("a.md", record.occurrences, record.title);
  assert.deepEqual(anchors.get(`bare:${await nameHash("Target")}`), { texts: ["the codename"], title: "Kickoff notes" });
  assert.deepEqual(anchors.get(`bare:${await nameHash("Other")}`), { texts: [], title: "Kickoff notes" });
  assert.deepEqual(anchors.get(`incoming:${await pathHash("sub/x.md")}`), { texts: ["label text"], title: "Kickoff notes" });
  const renamed = await buildNodeRecord("a.md", body.replace("the codename", "another name"), "2", { now: NOW });
  assert.notEqual(renamed.record.referenceSetVersion, record.referenceSetVersion, "an alias edit is a new reference set");
  const retitled = await buildNodeRecord("a.md", body.replace("Kickoff notes", "Kickoff"), "3", { now: NOW });
  assert.notEqual(retitled.record.referenceSetVersion, record.referenceSetVersion, "a title edit is a new reference set");
});

test("graph: display text is capped per text and per entry, and texts repeat once", async () => {
  const long = "x".repeat(ANCHOR_TEXT_CHARS + 40);
  const links = Array.from({ length: ANCHOR_TEXTS_PER_ENTRY + 3 }, (_, i) => `[[T|alias${i}]]`).join(" ");
  const { record } = await buildNodeRecord("a.md", `[[T|${long}]] [[T|alias0]] ${links}`, "1", { now: NOW });
  const { anchors } = await membershipsFor("a.md", record.occurrences, record.title);
  const { texts } = anchors.get(`bare:${await nameHash("T")}`);
  assert.equal(texts.length, ANCHOR_TEXTS_PER_ENTRY);
  assert.equal(texts[0].length, ANCHOR_TEXT_CHARS);
  assert.equal(new Set(texts).size, texts.length);
});

test("graph: a posting entry carries the texts and title, and an alias edit rewrites it", async () => {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  await initGraphManifest(store, big(), { mode: "conditional", now: NOW });
  await projectNote(store, "a.md", "# A title\n[[B|first alias]]", "1", { budget: big(), gen: "1", mode: "conditional", now: NOW });
  const hash = await nameHash("B");
  const posting = async () => (await readPostings(store, big(), { gen: "1", family: "bare", hash, canSee: () => true, validate: () => true })).entries;
  assert.deepEqual((await posting()).map(({ source, texts, title }) => ({ source, texts, title })), [{ source: "a.md", texts: ["first alias"], title: "A title" }]);
  const { state, touched } = await projectNote(store, "a.md", "# A title\n[[B|second alias]]", "2", { budget: big(), gen: "1", mode: "conditional", now: NOW });
  assert.equal(state, "projected");
  assert.deepEqual(touched, [{ name: "B" }]);
  assert.deepEqual((await posting())[0].texts, ["second alias"]);
  // An edit that changes no link, alias or title touches no posting.
  const quiet = await projectNote(store, "a.md", "# A title\n[[B|second alias]]\nmore words", "3", { budget: big(), gen: "1", mode: "conditional", now: NOW });
  assert.deepEqual(quiet.touched, []);
});

// ---------------------------------------------------------------- admission and caps

test("privacy: anchor text is admitted only from a source at least as wide as the target", () => {
  assert.equal(admitsAnchor("team", "team"), true);
  assert.equal(admitsAnchor("team", "private"), true);
  assert.equal(admitsAnchor("team", "@g"), true);
  assert.equal(admitsAnchor("@g", "@g"), true);
  assert.equal(admitsAnchor("@g", "private"), true);
  assert.equal(admitsAnchor("private", "private"), true);
  assert.equal(admitsAnchor("private", "team"), false);
  assert.equal(admitsAnchor("@g", "team"), false);
  assert.equal(admitsAnchor("@g1", "@g2"), false);
  assert.equal(admitsAnchor("private", "@g"), false);
  assert.equal(admitsAnchor(undefined, "team"), false);
});

test("collectAnchors: skips self, unknown and narrower sources, and caps sources per target", () => {
  const vis = (p) => (p.startsWith("p/") ? "private" : "team");
  const entries = [
    { source: "b.md", texts: ["self"], title: "B" },
    { source: "gone.md", texts: ["ghost"], title: "Gone" },
    { source: "p/secret.md", texts: ["hidden words"], title: "Secret" },
    ...Array.from({ length: ANCHOR_SOURCES_PER_TARGET + 5 }, (_, i) => ({ source: `s${String(i).padStart(2, "0")}.md`, texts: [`w${i}`], title: `S${i}` })),
  ];
  const known = (p) => p !== "gone.md";
  const got = collectAnchors(entries, { path: "b.md", known, visibilityOf: vis });
  assert.equal(got.sources.length, ANCHOR_SOURCES_PER_TARGET);
  assert.ok(!got.sources.includes("b.md") && !got.sources.includes("gone.md") && !got.sources.includes("p/secret.md"));
  assert.ok(!/hidden|ghost|self/.test(got.text));
  assert.match(got.text, /w0\b/);
  assert.equal(collectAnchors([], { path: "b.md", known, visibilityOf: vis }), null);
  // No visibility function: nothing is admitted.
  assert.equal(collectAnchors(entries.slice(3), { path: "b.md", known, visibilityOf: undefined }), null);
});

// ---------------------------------------------------------------- end to end

/** A bucket with `notes`, their graph projection, and a v3 index built in `format`. */
async function world(notes, { format = ANCHORS, rules = [{ prefix: "w", vis: "team" }], overrides = new Map() } = {}) {
  const store = r2LikeBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true };
  for (const [path, body] of Object.entries(notes)) await store.put(path, body);
  await initGraphManifest(store, big(), { mode: "conditional", now: NOW });
  for (const [path, body] of Object.entries(notes)) {
    const { state } = await projectNote(store, path, body, "1", { budget: big(), gen: "1", mode: "conditional", now: NOW });
    assert.equal(state, "projected", path);
  }
  store.searchIndexFormat = format;
  store.privacy = { rules, overrides };
  await converge(store);
  const manifest = await loadIndexManifest(store, big(), 0);
  assert.equal(manifest.layout.namespace, "v3");
  return store;
}

const visibilityFor = (store) => (path) => effectiveVisibility(path, store.privacy.rules, store.privacy.overrides);

async function converge(store) {
  for (let pass = 0; pass < 40; pass += 1) {
    const p = await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable, now: NOW, visibilityOf: visibilityFor(store) });
    if (p.pending === 0 && !p.listingTruncated) return;
  }
  throw new Error("did not converge");
}

async function search(store, query, scope = "workspace") {
  const answer = await searchIndexedNotes(store, {
    isVisible: (path) => canSee(path, scope, store.privacy.rules, store.privacy.overrides),
    isIndexable,
    query,
    budget: createSearchBudget(600),
  });
  return { paths: answer.hits.map((h) => h.key), matchCount: answer.matchCount };
}

const LINKED = {
  "w/a.md": "# Kickoff\n\nFirst meeting for [[b|qlcodename]] went well.\n",
  "w/b.md": "# The plan\n\nThe plan itself, in plain words.\n",
  "w/c.md": "# Unrelated\n\nNothing here.\n",
};

test("end to end: the alias finds the target only with the switch on", async () => {
  const on = await world(LINKED);
  assert.deepEqual((await search(on, "qlcodename")).paths.sort(), ["w/a.md", "w/b.md"]);
  // A's title is in B's anchor field too.
  assert.ok((await search(on, "kickoff")).paths.includes("w/b.md"));
  const off = await world(LINKED, { format: PLAIN });
  assert.deepEqual((await search(off, "qlcodename")).paths, ["w/a.md"]);
});

test("end to end: the anchor field weighs less than the target's own words", async () => {
  const store = await world({
    "w/a.md": "# A\n\nSee [[b|zebrafish]].\n",
    "w/b.md": "# B\n\nNothing about it.\n",
    "w/d.md": "# D\n\nzebrafish zebrafish notes.\n",
  });
  const { paths } = await search(store, "zebrafish");
  assert.ok(paths.indexOf("w/d.md") < paths.indexOf("w/b.md"), paths.join(","));
});

test("end to end: a bare link to an ambiguous name adds no anchor text", async () => {
  const store = await world({
    "w/a.md": "# A\n\nSee [[b|qlambiguous]].\n",
    "w/b.md": "# B one\n",
    "w/x/b.md": "# B two\n",
  });
  assert.deepEqual((await search(store, "qlambiguous")).paths, ["w/a.md"]);
});

test("privacy: a private source adds nothing to a team target, for any caller", async () => {
  const store = await world(
    { "p/a.md": "# Secret\n\nAbout [[b|qlsecretname]].\n", "w/b.md": "# B\n\nPlain.\n" },
    { rules: [{ prefix: "w", vis: "team" }, { prefix: "p", vis: "private" }] }
  );
  assert.deepEqual((await search(store, "qlsecretname", "workspace")).paths, []);
  assert.deepEqual((await search(store, "qlsecretname", "private")).paths, ["p/a.md"], "skipped at index time, not just hidden");
});

test("privacy: a team source does add to a private target", async () => {
  const store = await world(
    { "w/a.md": "# A\n\nAbout [[b|qlopenname]].\n", "p/b.md": "# B\n\nPlain.\n" },
    { rules: [{ prefix: "w", vis: "team" }, { prefix: "p", vis: "private" }] }
  );
  assert.deepEqual((await search(store, "qlopenname", "private")).paths.sort(), ["p/b.md", "w/a.md"]);
  assert.deepEqual((await search(store, "qlopenname", "workspace")).paths, ["w/a.md"]);
});

test("invariance: a source narrowed after indexing never makes the target findable to a caller who cannot see it", async () => {
  const notes = { "w/a.md": "# A\n\nAbout [[b|qlnarrowed]].\n", "w/b.md": "# B\n\nqlother plain words.\n", "w/c.md": "# C\n\nqlnarrowed qlother.\n" };
  const store = await world(notes);
  assert.ok((await search(store, "qlnarrowed")).paths.includes("w/b.md"));
  // privacy.md changes; no note changes, so nothing is re-indexed.
  store.privacy = { rules: [{ prefix: "w", vis: "team" }], overrides: new Map([["w/a.md", "private"]]) };
  const narrowed = await search(store, "qlnarrowed");
  // The answer a team caller gets equals the one from a world where A never linked B.
  const baseline = await world({ ...notes, "w/a.md": "# A\n\nAbout nothing.\n" });
  baseline.privacy = store.privacy;
  for (const query of ["qlnarrowed", "qlother", "qlnarrowed qlother"]) {
    assert.deepEqual(await search(store, query), await search(baseline, query), query);
  }
  assert.deepEqual(narrowed.paths, ["w/c.md"]);
  // The owner, who can see A, still gets it.
  assert.ok((await search(store, "qlnarrowed", "private")).paths.includes("w/b.md"));
});

test("chunks: the anchor field rides on a chunked note's first document only", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long plan with words.`).join(" ");
  const store = await world(
    { "w/a.md": "# A\n\nSee [[b|qlchunkalias]].\n", "w/b.md": `# B\n\n${long}\n\n## Part two\n\n${long}\n` },
    { format: indexFormatFor({ SEARCH_TOKENIZER: "2", SEARCH_CHUNK_CHARS: "1000", SEARCH_ANCHOR_TEXT: "1" }) }
  );
  const docs = [];
  for (const [key, { body }] of store.objects) if (key.startsWith(".context/search/v3/shards/")) docs.push(...JSON.parse(body).docs);
  const ofB = docs.filter(([, doc]) => doc.notePath === "w/b.md");
  assert.ok(ofB.length > 1, "B is chunked");
  assert.equal(ofB.filter(([, doc]) => doc.anchors).length, 1);
  assert.equal(ofB.find(([, doc]) => doc.anchors)[1].chunk, 0);
  assert.ok((await search(store, "qlchunkalias")).paths.includes("w/b.md"));
});

test("encrypted: a sealed target gets no anchor text, so nothing about it reaches the index", async () => {
  const store = await world({
    "w/a.md": "# A\n\nSee [[b|qlsealedalias]].\n",
    "w/b.md": "---\ncontext_encryption: v1\n---\nciphertext here\n",
  });
  assert.deepEqual((await search(store, "qlsealedalias")).paths, ["w/a.md"]);
  // The answer alone would not show it (search drops a sealed note's hits), so the shard is read.
  const docs = [];
  for (const [key, { body }] of store.objects) if (key.startsWith(".context/search/v3/shards/")) docs.push(...JSON.parse(body).docs);
  const b = docs.find(([path]) => path === "w/b.md");
  assert.ok(b, "the sealed note is indexed (its version, no words)");
  assert.equal(b[1].anchors, undefined);
  assert.ok(!JSON.stringify(docs).includes("qlsealed"));
});

test("census: the graph and the D1 projection see a note's real version, never the unread mark", () => {
  const manifest = { docsByShard: [new Map([["a.md", `v1${ANCHORS_UNREAD}`], ["b.md", "v2"]])] };
  assert.deepEqual([...censusFromManifest(manifest)], [["a.md", "v1"], ["b.md", "v2"]]);
});

// ---------------------------------------------------------------- freshness

test("freshness: a write that edits the alias refreshes the target behind the write", async () => {
  const store = await world(LINKED);
  const body = LINKED["w/a.md"].replace("qlcodename", "qlrenamed");
  const put = await store.put("w/a.md", body);
  await projectNoteAfterWrite(store, { path: "w/a.md", body, version: put.etag, budget: createSearchBudget(80), visibilityOf: visibilityFor(store) });
  // A's own document is the write path's targeted pass (activity/record.js), not run here.
  assert.ok(!(await search(store, "qlcodename")).paths.includes("w/b.md"));
  assert.ok((await search(store, "qlrenamed")).paths.includes("w/b.md"));
});

test("freshness: deleting the source removes its words from the target within one maintenance pass", async () => {
  const store = await world(LINKED);
  const deferred = [];
  store.defer = (p) => deferred.push(p);
  await store.delete("w/a.md");
  await maintainIndexAfter(store, createSearchBudget(600), isIndexable, null, visibilityFor(store));
  await Promise.all(deferred);
  assert.deepEqual((await search(store, "qlcodename")).paths, []);
});

test("freshness: a refresh the pass cannot afford is kept in the v3 manifest and done by the next pass", async () => {
  const store = await world(LINKED);
  const body = LINKED["w/a.md"].replace("qlcodename", "qlqueued");
  const put = await store.put("w/a.md", body);
  // Budget for the graph only: the refresh is queued, not done.
  await projectNoteAfterWrite(store, { path: "w/a.md", body, version: put.etag, budget: createSearchBudget(80), visibilityOf: visibilityFor(store), refreshBudget: 3 });
  assert.ok(!(await search(store, "qlqueued")).paths.includes("w/b.md"));
  await syncShardedIndex(store, { budget: createSearchBudget(4000), isIndexable, now: NOW, visibilityOf: visibilityFor(store) });
  assert.ok((await search(store, "qlqueued")).paths.includes("w/b.md"));
});

// ---------------------------------------------------------------- budget

test("budget: at DEFERRED_SYNC_FLOOR the anchor build is served as fast as without anchors, v2 progress is unchanged, and every anchor is read once served", async () => {
  // The Task 31 liveness cell's shape (40 notes, one folder), each note linking the next by alias.
  const notes = Array.from({ length: 40 }, (_, i) => ({ path: `f0/n${i}.md`, text: `# N${i}\n\nword${i} see [[n${(i + 1) % 40}|qlalias${i}]]\n` }));
  const make = async (format) => {
    const store = r2LikeBucket();
    store.capabilities = { conditionalWrite: true, conditionalCreate: true };
    for (const note of notes) await store.put(note.path, note.text);
    await initGraphManifest(store, big(), { mode: "conditional", now: NOW });
    for (const note of notes) await projectNote(store, note.path, note.text, "1", { budget: big(), gen: "1", mode: "conditional", now: NOW });
    store.searchIndexFormat = format;
    return store;
  };
  const on = await make(ANCHORS);
  const off = await make(PLAIN);
  const v2 = (store) => store.objects.get(DOCMAP_KEY)?.body ?? null;
  const served = async (store) => (await loadIndexManifest(store, big(), 0)).layout.namespace === "v3";
  const quiet = console.log;
  console.log = () => {};
  let servedOn = 0;
  let servedOff = 0;
  try {
    for (let pass = 1; pass <= 1000 && (!servedOn || !servedOff); pass += 1) {
      // One fixed clock for every pass, so both arms are deterministic. (A clock
      // that moves between passes makes the v2 pass rewrite its manifest every
      // time, and at this budget v3 then never advances, with or without
      // anchors: measured, pre-existing.)
      if (!servedOn) await syncShardedIndex(on, { budget: DEFERRED_SYNC_FLOOR, now: NOW, visibilityOf: () => "team" });
      if (!servedOff) await syncShardedIndex(off, { budget: DEFERRED_SYNC_FLOOR, now: NOW });
      if (!servedOn && !servedOff) assert.equal(v2(on), v2(off), `v2 docmap after pass ${pass}`);
      if (!servedOn && (await served(on))) servedOn = pass;
      if (!servedOff && (await served(off))) servedOff = pass;
    }
    assert.ok(servedOn > 0 && servedOff > 0, `served: anchors ${servedOn}, without ${servedOff}`);
    assert.ok(servedOn <= servedOff, `anchors ${servedOn} passes vs ${servedOff} without`);
    // Notes indexed before their anchors could be afforded are re-read once v3 is served.
    const unread = () => [...on.objects.get(V3_DOCMAP_KEY).body.matchAll(/\\u0000anchors/g)].length;
    let pass = 0;
    for (; pass < 400 && unread() > 0; pass += 1) {
      await syncShardedIndex(on, { budget: DEFERRED_SYNC_FLOOR, now: NOW, visibilityOf: () => "team" });
    }
    assert.equal(unread(), 0, `marks left after ${pass} passes`);
  } finally {
    console.log = quiet;
  }
  on.privacy = { rules: [{ prefix: "f0", vis: "team" }], overrides: new Map() };
  for (let i = 0; i < 40; i += 1) assert.ok((await search(on, `qlalias${i}`)).paths.includes(`f0/n${(i + 1) % 40}.md`), `qlalias${i}`);
});
