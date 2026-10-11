/**
 * The list and the write guard fail closed on unreadable move state (leftover
 * 3). `listVisibleNoteKeysWithMoves` (list_notes, the move-aware scan,
 * evaluate_lists) and `pathUnderActiveMovedSource` (the write guard) used to
 * read an unreadable move state as "no moves". The list now answers nothing,
 * labelled; the write is refused with the answer an active move gives.
 *
 * ## Sabotage record
 *
 *   both functions back on loadMoveJobs ([] on failure)     3 here
 *   scan: the null check after the move-aware list removed   1 here (TypeError)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveJobKey } from "../src/moves/jobs.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { listVisibleNoteKeysWithMoves } from "../src/notes/visibleKeys.js";
import { scanVisibleNotes } from "../src/search/scan.js";
import { toolListNotes } from "../src/tools/notes/read.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { memoryBucket } from "./store/fixtures.mjs";

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  private: private\n\n" +
  "note_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const { rules, overrides } = parsePrivacyManifest(MANIFEST);

const ID = "job-0000000000001";
const MOVING_JOB = JSON.stringify({
  version: 1, id: ID, source: "1-projects/mv", destination: "private/mv", status: "logical_active",
  created_at: "2026-01-01", objects: [{ source: "1-projects/mv/a.md", destination: "private/mv/a.md" }],
});

async function world({ hidden }) {
  const store = memoryBucket();
  await store.put("1-projects/open.md", "# Open\n\nvisible\n");
  await store.put("1-projects/mv/a.md", "# Moving\n\nsecret plan\n");
  if (hidden) await store.put("private/other.md", "# Hidden\n\nnot for team\n");
  return store;
}
const failing = (store) => ({
  ...store,
  list: (o) => (o?.prefix === ".context/moves/" ? Promise.reject(new Error("list failed")) : store.list(o)),
});
const list = async (store, prefix) => (await toolListNotes(store, "team", rules, overrides, prefix)).content[0].text;
const write = async (store, path) =>
  (await toolWriteNote(store, "team", rules, overrides, { path, content: "# New\n\nbody\n" })).content[0].text;

test("healthy: list_notes lists visible notes and a write to a free path succeeds", async () => {
  const store = await world({ hidden: false });
  assert.match(await list(store), /1-projects\/open\.md/);
  assert.doesNotMatch(await write(store, "1-projects/free.md"), /conflict/);
});

test("healthy: an active move still refuses a write under its source", async () => {
  const store = await world({ hidden: false });
  await store.put(moveJobKey(ID), MOVING_JOB);
  assert.match(await write(store, "1-projects/mv/new.md"), /being moved/);
});

test("unreadable move state: list_notes lists nothing, and hidden notes change nothing", async () => {
  const withHidden = await list(failing(await world({ hidden: true })));
  const without = await list(failing(await world({ hidden: false })));
  assert.equal(withHidden, without);
  assert.doesNotMatch(withHidden, /open\.md|mv\/a\.md|private/);
  assert.equal(await listVisibleNoteKeysWithMoves(failing(await world({ hidden: false })), "team", rules, overrides, ""), null);
});

test("unreadable move state: a prefixed list says the same", async () => {
  const text = await list(failing(await world({ hidden: true })), "1-projects");
  assert.equal(text, await list(failing(await world({ hidden: false })), "1-projects"));
  assert.doesNotMatch(text, /\.md/);
});

test("unreadable move state: a write is refused with the active-move answer, for any path", async () => {
  const store = failing(await world({ hidden: true }));
  const active = await world({ hidden: true });
  await active.put(moveJobKey(ID), MOVING_JOB);
  const expected = await write(active, "1-projects/mv/new.md");
  assert.match(expected, /being moved/);
  assert.equal(await write(store, "1-projects/free.md"), expected);
  assert.equal(await write(store, "private/free.md"), await write(store, "1-projects/free.md"));
  assert.equal(await (async () => (await store.get("1-projects/free.md")))(), null);
});

// The scan reads the move state first (healthy, an active move), then the
// move-aware list reads it again. Only the second read fails, so the scan's
// own null branch is the one that answers.
const failsOnSecondMoveList = (store) => {
  let reads = 0;
  return {
    ...store,
    list: (o) => (o?.prefix === ".context/moves/" && (reads += 1) > 1 ? Promise.reject(new Error("list failed")) : store.list(o)),
  };
};
const scan = async (store) => {
  await store.put(moveJobKey(ID), MOVING_JOB);
  return scanVisibleNotes(failsOnSecondMoveList(store), "team", rules, overrides, "visible", "1-projects", null);
};

test("scan: a move-aware list that cannot read the move state serves nothing, and hidden notes change nothing", async () => {
  const healthy = await world({ hidden: true });
  await healthy.put(moveJobKey(ID), MOVING_JOB);
  const control = await scanVisibleNotes(healthy, "team", rules, overrides, "visible", "1-projects", null);
  assert.ok(control.hits.length > 0, "the fixture finds a note when the move state is readable");
  const withHidden = await scan(await world({ hidden: true }));
  assert.deepEqual(withHidden, { hits: [], scannedCount: 0, totalCount: 0, totalIsFloor: true });
  assert.deepEqual(withHidden, await scan(await world({ hidden: false })));
});
