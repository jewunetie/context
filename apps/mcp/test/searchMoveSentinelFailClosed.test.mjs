/**
 * search_notes fails closed when the move state cannot be read (pre-existing
 * issue 3). An unreadable sentinel used to mean "no move", so a note moving
 * into a private folder could be searched at its source path.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   moveSentinelActive returning false on a read error (old behavior)   2 here
 *   searchMoveJobs returning [] when the markers cannot be read          1 here
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveJobKey } from "../src/moves/jobs.js";
import { MOVE_SENTINEL_KEY } from "../src/moves/limits.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { searchVisibleNotes } from "../src/search/visibleNotes.js";
import { memoryBucket } from "./store/fixtures.mjs";

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  private: private\n\n" +
  "note_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const { rules, overrides } = parsePrivacyManifest(MANIFEST);

const ID = "job-0000000000001";
const MOVING = "1-projects/mv/a.md";
const JOB = JSON.stringify({
  version: 1, id: ID, source: "1-projects/mv", destination: "private/mv", status: "logical_active",
  created_at: "2026-01-01", objects: [{ source: MOVING, destination: "private/mv/a.md" }],
});

let counter = 0;
/** A fresh workspace id per world: the in-isolate move hint is keyed on it. */
async function world({ marker = true } = {}) {
  const store = memoryBucket();
  store.actor = { workspaceId: `ws-sentinel-${(counter += 1)}` };
  await store.put("1-projects/visible.md", "# Visible\n\nkestrel plan\n");
  await store.put(MOVING, "# Moving\n\nkestrel secret plan\n");
  if (marker) {
    await store.put(MOVE_SENTINEL_KEY, JSON.stringify({ version: 1, active: true }));
    await store.put(moveJobKey(ID), JOB);
  }
  return store;
}
const search = (store) => searchVisibleNotes(store, "team", rules, overrides, "kestrel");
const paths = (answer) => answer.hits.map((hit) => hit.key);

test("non-vacuous: with a readable sentinel the moving note is withheld and the answer is the labelled scan", async () => {
  const answer = await search(await world());
  assert.equal(answer.degraded, true);
  assert.ok(paths(answer).includes("1-projects/visible.md"), JSON.stringify(answer));
  assert.ok(!paths(answer).includes(MOVING));
});

test("an unreadable sentinel with readable markers still withholds the moving note", async () => {
  const store = await world();
  const failing = Object.assign(Object.create(store), {
    get: (key) => (key === MOVE_SENTINEL_KEY ? Promise.reject(new Error("read failed")) : store.get(key)),
  });
  const answer = await search(failing);
  assert.ok(!paths(answer).includes(MOVING), JSON.stringify(answer));
  assert.equal(answer.degraded, true);
});

test("an unreadable move state serves nothing, labelled", async () => {
  const store = await world();
  const failing = Object.assign(Object.create(store), {
    get: (key) => (key === MOVE_SENTINEL_KEY ? Promise.reject(new Error("read failed")) : store.get(key)),
    list: (options) => (options?.prefix === ".context/moves/" ? Promise.reject(new Error("list failed")) : store.list(options)),
  });
  const answer = await search(failing);
  assert.deepEqual(paths(answer), []);
  assert.equal(answer.degraded, true);
  assert.equal(answer.totalIsFloor, true);
});
