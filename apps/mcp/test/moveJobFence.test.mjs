/**
 * A finished move is a fence (leftover 2). `persistMoveJob` was an unconditional
 * put, and the logical-delete wrapper allows a put over a tombstone for an
 * internal path, so a stale materializer pass could bring a finished move back
 * (status "copying" returned). It now writes only over a job that is still
 * active.
 *
 * ## Sabotage record
 *
 *   persistMoveJob as the unconditional put      2 here (tombstone, completed)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveJobKey, persistMoveJob } from "../src/moves/jobs.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { memoryBucket } from "./store/fixtures.mjs";

const ID = "move-0000000000001";
const job = (status, extra = {}) => ({
  version: 1, id: ID, status, source: "1-projects/x", destination: "1-projects/y", created_at: "2026-01-01",
  updated_at: "2026-01-01", total_objects: 0, copied_objects: 0, deleted_objects: 0, copied: [], objects: [], error: null,
  ...extra,
});

function world() {
  const raw = memoryBucket();
  raw.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  return { raw, store: withLogicalDelete(raw) };
}
const stored = async (store) => {
  const object = await store.get(moveJobKey(ID));
  return object ? JSON.parse(await object.text()) : null;
};

test("a stale pass cannot put an older state over a tombstoned move", async () => {
  const { store } = world();
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active")));
  const stale = job("copying", { copied: ["a"] });
  await store.put(moveJobKey(ID), JSON.stringify(job("complete")));
  await store.delete(moveJobKey(ID));
  assert.equal(await persistMoveJob(store, stale), false);
  assert.equal(await stored(store), null, "the move stays finished");
});

test("a stale pass cannot put an older state over a completed marker", async () => {
  const { store } = world();
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active")));
  const stale = job("copying");
  await store.put(moveJobKey(ID), JSON.stringify(job("complete")));
  assert.equal(await persistMoveJob(store, stale), false);
  assert.equal((await stored(store)).status, "complete");
});

test("an unfinished move still progresses, including rollback and pending-removal states", async () => {
  const { store } = world();
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active")));
  for (const status of ["copying", "deleting", "needs_cleanup", "copying"]) {
    assert.equal(await persistMoveJob(store, job(status, { error: status === "copying" ? "boom" : null })), true);
    assert.equal((await stored(store)).status, status);
  }
  assert.equal(await persistMoveJob(store, job("complete")), true);
  assert.equal((await stored(store)).status, "complete");
});
