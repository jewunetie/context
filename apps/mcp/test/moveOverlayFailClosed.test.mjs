/**
 * The move overlay fails closed (pre-existing issue 1). When the move state
 * cannot be read, a note that may be moving into a private folder is not served
 * at its source path, and the answer is the one an unreadable path gets.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   loadMoveJobsOrNull returning [] on a failure (the old behavior)   2 here
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveJobKey } from "../src/moves/jobs.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { toolReadNote } from "../src/tools/notes/read.js";
import { memoryBucket } from "./store/fixtures.mjs";

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  private: private\n\n" +
  "note_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const { rules, overrides } = parsePrivacyManifest(MANIFEST);

const ID = "job-0000000000001";
const SOURCE = "1-projects/mv/a.md";
const MOVING_JOB = JSON.stringify({
  version: 1, id: ID, source: "1-projects/mv", destination: "private/mv", status: "logical_active",
  created_at: "2026-01-01", objects: [{ source: SOURCE, destination: "private/mv/a.md" }],
});

async function world() {
  const store = memoryBucket();
  await store.put(SOURCE, "# Moving\n\nsecret plan\n");
  await store.put(moveJobKey(ID), MOVING_JOB);
  return store;
}

const read = async (store, path = SOURCE) => (await toolReadNote(store, "team", rules, overrides, path)).content[0].text;

test("non-vacuous: with the move state readable, a team caller is refused the moving note", async () => {
  assert.equal(await read(await world()), "not found");
});

test("a failed move listing does not serve a moving note's text at its source path", async () => {
  const store = await world();
  const failing = { ...store, list: (o) => (o?.prefix === ".context/moves/" ? Promise.reject(new Error("list failed")) : store.list(o)) };
  const text = await read(failing);
  assert.equal(text, "not found");
  assert.equal(text, await read(failing, "1-projects/never-existed.md"));
});

test("a failed marker read does not serve a moving note's text at its source path", async () => {
  const store = await world();
  const failing = { ...store, get: (k) => (k === moveJobKey(ID) ? Promise.reject(new Error("read failed")) : store.get(k)) };
  assert.equal(await read(failing), "not found");
});
