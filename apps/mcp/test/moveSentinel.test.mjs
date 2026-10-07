/**
 * The move-job markers and the active-move sentinel (`.context/moves/active`)
 * (Task 17 fix rounds 2 and 3). The markers decide, read fail closed whatever
 * the sentinel says; a refresh removes the sentinel only when the markers read
 * as none, and only if it is still the sentinel the refresh saw.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   round 3: the round-2 sentinel gate put back         2 here (no sentinel or unreadable, refresh between), 2 relatedNotesTool
 *   refresh deleting when the markers cannot be read   1 (never removes)
 *   refresh deleting unconditionally                   1 (racing a new move)
 *   move_folder writing its marker before the sentinel 1 relatedNotesTool (sentinel before its job marker)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { activeMoveJobsOrNull, moveJobKey, refreshMoveSentinel, writeMoveSentinel } from "../src/moves/jobs.js";
import { MOVE_SENTINEL_KEY } from "../src/moves/limits.js";
import { memoryBucket } from "./store/fixtures.mjs";

const job = (id, status = "logical_active") =>
  JSON.stringify({ version: 1, id, source: "a", destination: "b", status, created_at: "2026-01-01", objects: [] });
const ID = "job-0000000000001";

// Fix round 3: no sentinel gate. The markers are read whatever the sentinel
// says, the same reads read_note's overlay makes, so a sentinel removed by a
// racing refresh cannot hide an active move. (Replaces round 2's "no
// sentinel: one get and no listing" and "an unreadable sentinel reads the
// markers", which pinned the gate; this pins the stronger rule that the
// sentinel never decides.)
test("an active marker is found with no sentinel and with an unreadable one", async () => {
  const store = memoryBucket();
  await store.put(moveJobKey(ID), job(ID));
  assert.deepEqual((await activeMoveJobsOrNull(store)).map((j) => j.id), [ID]);
  const failing = { ...store, get: (k) => (k === MOVE_SENTINEL_KEY ? Promise.reject(new Error("read failed")) : store.get(k)) };
  assert.deepEqual((await activeMoveJobsOrNull(failing)).map((j) => j.id), [ID]);
});

test("a refresh between a new move's first sentinel and its marker does not hide the move", async () => {
  const store = memoryBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  await writeMoveSentinel(store); // the move's first write
  await refreshMoveSentinel(store); // lists no marker yet and removes it
  await store.put(moveJobKey(ID), job(ID)); // the marker lands
  assert.ok(!store.objects.has(MOVE_SENTINEL_KEY), "non-vacuous: the sentinel is gone");
  assert.deepEqual((await activeMoveJobsOrNull(store)).map((j) => j.id), [ID]);
});

test("a refresh never removes the sentinel when the markers cannot be read", async () => {
  const store = memoryBucket();
  await writeMoveSentinel(store);
  await store.put(moveJobKey(ID), "{ half a marker");
  await refreshMoveSentinel(store);
  assert.ok(store.objects.has(MOVE_SENTINEL_KEY));
  // Once the markers read as none, it goes.
  await store.put(moveJobKey(ID), job(ID, "complete"));
  await refreshMoveSentinel(store);
  assert.ok(!store.objects.has(MOVE_SENTINEL_KEY));
});

test("a refresh racing a new move keeps the sentinel on a store with conditional delete", async () => {
  const store = memoryBucket();
  store.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  await writeMoveSentinel(store);
  let raced = false;
  const racing = {
    ...store,
    // The refresh lists the markers and sees none; a new move then writes its
    // sentinel and marker before the refresh's delete.
    async list(options) {
      const page = await store.list(options);
      if (!raced && options?.prefix === ".context/moves/") {
        raced = true;
        await writeMoveSentinel(store);
        await store.put(moveJobKey(ID), job(ID));
      }
      return page;
    },
  };
  await refreshMoveSentinel(racing);
  assert.ok(raced);
  assert.ok(store.objects.has(MOVE_SENTINEL_KEY), "the new move's sentinel survives the refresh");
  assert.deepEqual((await activeMoveJobsOrNull(store)).map((j) => j.id), [ID]);
});
