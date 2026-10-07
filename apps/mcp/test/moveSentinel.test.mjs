/**
 * The active-move sentinel (`.context/moves/active`) as the gate in front of
 * the move-job markers (Task 17 fix round 2). Absent means no active move in
 * one op; present or unreadable means the markers are read, fail closed; a
 * refresh removes it only when the markers read as none, and only if it is
 * still the sentinel the refresh saw.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   markers read without the sentinel gate             1 here (no sentinel), 1 relatedNotesTool (100 finished moves)
 *   an unreadable sentinel read as absent              1 (cannot be read)
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

test("no sentinel: no active jobs, one get and no listing", async () => {
  const store = memoryBucket();
  await store.put(moveJobKey(ID), job(ID));
  const ops = [];
  const watched = { ...store, get: (k) => (ops.push(`get:${k}`), store.get(k)), list: (o) => (ops.push(`list:${o?.prefix}`), store.list(o)) };
  assert.deepEqual(await activeMoveJobsOrNull(watched), []);
  assert.deepEqual(ops, [`get:${MOVE_SENTINEL_KEY}`]);
});

test("a sentinel that cannot be read means the markers are read", async () => {
  const store = memoryBucket();
  await store.put(moveJobKey(ID), job(ID));
  const failing = { ...store, get: (k) => (k === MOVE_SENTINEL_KEY ? Promise.reject(new Error("read failed")) : store.get(k)) };
  assert.deepEqual((await activeMoveJobsOrNull(failing)).map((j) => j.id), [ID]);
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
