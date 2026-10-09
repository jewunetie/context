/**
 * read_note costs the same for a hidden move destination as for an absent path
 * (pre-existing issue 6). Following a move to the hidden destination used to
 * probe the source as well, one operation more than a path that is not there.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   the hidden-path early return removed from getVisibleMovedNote   1 here
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
const JOB = JSON.stringify({
  version: 1, id: ID, source: "1-projects/mv", destination: "private/mv", status: "logical_active",
  created_at: "2026-01-01", objects: [{ source: "1-projects/mv/a.md", destination: "private/mv/a.md" }],
});

/** Every storage call read_note makes, with the asked path replaced by <P>. */
async function ops(store, path) {
  const log = [];
  const recording = new Proxy(store, {
    get(target, name) {
      const member = target[name];
      if (typeof member !== "function") return member;
      return (...args) => {
        log.push(`${String(name)}:${String(args[0]?.prefix ?? args[0]).replaceAll(path, "<P>")}`);
        return member.apply(target, args);
      };
    },
  });
  const text = (await toolReadNote(recording, "team", rules, overrides, path)).content[0].text;
  return { text, log };
}

test("a hidden move destination costs what an absent path costs, and answers alike", async () => {
  const store = memoryBucket();
  await store.put("1-projects/mv/a.md", "# Moving\n\nsecret plan\n");
  await store.put(moveJobKey(ID), JOB);
  const hidden = await ops(store, "private/mv/a.md");
  const absent = await ops(store, "private/never.md");
  assert.equal(hidden.text, "not found");
  assert.deepEqual(hidden, absent);
  assert.ok(hidden.log.length > 0);
});

test("the same holds once the destination exists", async () => {
  const store = memoryBucket();
  await store.put("1-projects/mv/a.md", "# Moving\n\nsecret plan\n");
  await store.put("private/mv/a.md", "# Moving\n\nsecret plan\n");
  await store.put(moveJobKey(ID), JOB);
  assert.deepEqual(await ops(store, "private/mv/a.md"), await ops(store, "private/never.md"));
});
