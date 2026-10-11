/**
 * Finished moves leave a logical-delete tombstone under `.context/moves/` that
 * nothing used to remove. Maintenance now reclaims them: only tombstones older
 * than MOVE_TOMBSTONE_GRACE_MS, at most MOVE_RECLAIM_PER_PASS a pass, only when
 * the same pass found nothing pending in the index or the graph, and never when
 * the graph kill switch is on. Live markers (any status), the sentinel and any
 * other key are never touched. Reclaiming does not open the finished-move
 * fence: an absent job is refused by persistMoveJob like a finished one.
 *
 * ## Sabotage record
 *
 *   no age check on the tombstone                         2 here (before grace, maintenance)
 *   no marker-body check (size and age only)              1 here (live job of marker size)
 *   no per-pass cap                                       1 here (bounded)
 *   the pending checks removed from maintenance           1 here (pending)
 *   the kill switch check removed from maintenance        1 here (kill switch)
 *   persistMoveJob creating an absent job                 1 here (fence after reclaim)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MOVE_RECLAIM_PER_PASS, MOVE_TOMBSTONE_GRACE_MS } from "../src/moves/limits.js";
import { moveJobKey, persistMoveJob, reclaimMoveTombstones } from "../src/moves/jobs.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { toolMaterializeMove } from "../src/tools/moves/materialize.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { memoryBucket } from "./store/fixtures.mjs";

const CAPS = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 2 * MOVE_TOMBSTONE_GRACE_MS);
const job = (id, status, extra = {}) => ({
  version: 1, id, status, source: "1-projects/x", destination: "1-projects/y", created_at: "2026-01-01",
  updated_at: "2026-01-01", total_objects: 0, copied_objects: 0, deleted_objects: 0, copied: [], objects: [], error: null,
  ...extra,
});
const idOf = (n) => `move-${String(n).padStart(13, "0")}`;

/** A bucket whose listing reports `uploaded` from `ages` (default: long ago) and counts every call. */
function world() {
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  const ages = new Map();
  const ops = { n: 0 };
  for (const name of ["get", "put", "delete", "list"]) {
    const original = raw[name].bind(raw);
    raw[name] = async (...args) => {
      ops.n += 1;
      const result = await original(...args);
      if (name !== "list") return result;
      return {
        ...result,
        objects: result.objects.map((o) => ({ ...o, size: raw.objects.get(o.key).body.length, uploaded: ages.has(o.key) ? ages.get(o.key) : OLD })),
      };
    };
  }
  return { raw, store: withLogicalDelete(raw), ages, ops };
}
async function finish(store, n) {
  const key = moveJobKey(idOf(n));
  await store.put(key, JSON.stringify(job(idOf(n), "logical_active"), null, 2));
  await store.delete(key);
  return key;
}
const reclaim = (store, take = () => true, olderThan = Date.now() - MOVE_TOMBSTONE_GRACE_MS) =>
  reclaimMoveTombstones(store, { olderThan, take });

test("tombstones past the grace are reclaimed, a few per pass, and the rest on later passes (idempotent)", async () => {
  const { raw, store } = world();
  const keys = [];
  for (let n = 1; n <= 12; n += 1) keys.push(await finish(store, n));
  assert.ok(keys.every((key) => raw.objects.has(key)), "tombstones exist physically");
  assert.equal(await reclaim(store), MOVE_RECLAIM_PER_PASS);
  assert.equal(keys.filter((key) => !raw.objects.has(key)).length, MOVE_RECLAIM_PER_PASS);
  await reclaim(store);
  await reclaim(store);
  assert.ok(keys.every((key) => !raw.objects.has(key)));
  assert.equal(await reclaim(store), 0);
});

test("not before the grace, and never without a listing time", async () => {
  const { raw, store, ages } = world();
  const key = await finish(store, 1);
  ages.set(key, new Date(Date.now() - MOVE_TOMBSTONE_GRACE_MS + DAY));
  assert.equal(await reclaim(store), 0);
  const old = await finish(store, 2);
  ages.set(old, null);
  assert.equal(await reclaim(store), 0);
  assert.ok(raw.objects.has(key) && raw.objects.has(old));
  ages.set(key, new Date(Date.now() - MOVE_TOMBSTONE_GRACE_MS - DAY));
  assert.equal(await reclaim(store), 1);
});

test("live markers in every state, the sentinel and other keys are never touched", async () => {
  const { raw, store } = world();
  const live = [];
  for (const [n, status, extra] of [
    [1, "logical_active"], [2, "copying"], [3, "deleting"], [4, "needs_cleanup"],
    [5, "copying", { error: "rollback after a failed pass" }], [6, "complete"],
  ]) {
    const key = moveJobKey(idOf(n));
    await store.put(key, JSON.stringify(job(idOf(n), status, extra), null, 2));
    live.push(key);
  }
  await store.put(".context/moves/active", "x".repeat(123));
  // A live object of exactly the tombstone size must be caught by the body check.
  await store.put(moveJobKey(idOf(7)), "y".repeat(123));
  live.push(moveJobKey(idOf(7)), ".context/moves/active");
  // Tombstones elsewhere are not ours to remove.
  await store.put("1-projects/gone.md", "# gone\n");
  await store.delete("1-projects/gone.md");
  await store.put(".context/other/gone.json", "{}");
  await store.delete(".context/other/gone.json");
  const elsewhere = ["1-projects/gone.md", ".context/other/gone.json"];
  const mine = await finish(store, 8);
  assert.equal(await reclaim(store), 1);
  assert.equal(raw.objects.has(mine), false);
  for (const key of [...live, ...elsewhere]) assert.ok(raw.objects.has(key), `${key} is kept`);
});

test("one pass is bounded, and stops when the budget does", async () => {
  const { store, ops } = world();
  for (let n = 1; n <= 60; n += 1) await finish(store, n);
  ops.n = 0;
  await reclaim(store);
  assert.ok(ops.n <= 1 + 2 * MOVE_RECLAIM_PER_PASS, `store ops ${ops.n}`);
  let left = 3;
  ops.n = 0;
  await reclaim(store, () => left-- > 0);
  assert.ok(ops.n <= 3, `a budget of 3 spends at most 3, spent ${ops.n}`);
});

test("after a reclaim a stale pass cannot revive the move", async () => {
  const { raw, store } = world();
  const key = await finish(store, 1);
  const stale = job(idOf(1), "copying", { copied: ["a"] });
  assert.equal(await reclaim(store, undefined, Date.now() + DAY), 1);
  assert.equal(raw.objects.has(key), false);
  assert.equal(await persistMoveJob(store, stale), false);
  assert.equal(raw.objects.has(key), false, "nothing was created");
  const result = await toolMaterializeMove(store, "private", idOf(1), 10);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

// -- through the maintenance pass -------------------------------------------

function gateway({ writeEnrichBudget, age = OLD, unreadable } = {}) {
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  const deferred = [];
  const base = {
    capabilities: CAPS,
    actor: { workspaceId: "w_reclaim", userId: "u_owner" },
    get: (k) => (k === unreadable ? Promise.reject(new Error("unreadable")) : raw.get(k)),
    put: (k, v, o) => raw.put(k, v, o),
    delete: (k, o) => raw.delete(k, o),
    async list(o = {}) {
      const page = await raw.list(o);
      return {
        ...page,
        objects: page.objects.map((x) => ({ ...x, size: raw.objects.get(x.key)?.body.length, etag: raw.objects.get(x.key)?.etag, uploaded: x.key.startsWith(".context/moves/") ? age : x.uploaded })),
      };
    },
    defer: (p) => deferred.push(p),
  };
  if (writeEnrichBudget !== undefined) base.writeEnrichBudget = writeEnrichBudget;
  const store = withLogicalDelete(base);
  const maintain = async (budget = 600) => {
    await maintainIndexAfter(store, createSearchBudget(budget), defaultIsIndexable, null);
    await Promise.all(deferred.splice(0));
  };
  return { raw, store, maintain };
}
async function seed(g) {
  await g.store.put("a.md", "see [b](./b.md)");
  await g.store.put("b.md", "# b\n");
  const keys = [await finish(g.store, 1), await finish(g.store, 2)];
  const liveKey = moveJobKey(idOf(3));
  await g.store.put(liveKey, JSON.stringify(job(idOf(3), "copying"), null, 2));
  return { keys, liveKey };
}
const settle = async (g) => { for (let i = 0; i < 4; i += 1) await g.maintain(); };

test("maintenance reclaims old tombstones and leaves the live move", async () => {
  const g = gateway();
  const { keys, liveKey } = await seed(g);
  await settle(g);
  assert.ok(keys.every((key) => !g.raw.objects.has(key)), "reclaimed");
  assert.ok(g.raw.objects.has(liveKey), "the unfinished move stays");
});

test("maintenance keeps tombstones inside the grace", async () => {
  const g = gateway({ age: new Date(Date.now() - DAY) });
  const { keys } = await seed(g);
  await settle(g);
  assert.ok(keys.every((key) => g.raw.objects.has(key)));
});

test("maintenance does not reclaim under the graph kill switch or with no budget", async () => {
  const off = gateway({ writeEnrichBudget: 0 });
  const seeded = await seed(off);
  await settle(off);
  assert.ok(seeded.keys.every((key) => off.raw.objects.has(key)), "kill switch");
  const none = gateway();
  const other = await seed(none);
  for (let i = 0; i < 4; i += 1) await none.maintain(0);
  assert.ok(other.keys.every((key) => none.raw.objects.has(key)), "no budget");
});

test("maintenance waits while the index still has a note pending", async () => {
  const bad = "notes/unreadable.md";
  const g = gateway({ unreadable: bad });
  const { keys } = await seed(g);
  await g.raw.put(bad, "# never fetched\n");
  await settle(g);
  const manifest = JSON.parse(g.raw.objects.get(".context/search/index/manifest.json").body);
  assert.equal(manifest.freshness.pending, 1, "the fixture leaves one note pending");
  assert.ok(keys.every((key) => g.raw.objects.has(key)), "pending work means no reclaim");
});
