/**
 * A finished move is a fence (leftover 2). `persistMoveJob` was an unconditional
 * put, and the logical-delete wrapper allows a put over a tombstone for an
 * internal path, so a stale materializer pass could bring a finished move back
 * (status "copying" returned). It now writes only over a job that is still
 * active.
 *
 * Concurrent active passes are fenced against each other with a generation
 * carried in the job: a writer must carry the generation it read, so a pass
 * that read the job before another pass advanced it backs off instead of
 * putting an older state over the newer one.
 *
 * ## Sabotage record
 *
 *   persistMoveJob as the unconditional put      2 here (tombstone, completed)
 *   the generation compare removed               2 here (interleave, stale pass)
 *   the read-back after an unconditional put removed   1 here (fallback)
 *   the complete step ignoring a refused persist  1 here (clean-up once)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { moveJobKey, persistMoveJob } from "../src/moves/jobs.js";
import { toolMaterializeMove } from "../src/tools/moves/materialize.js";
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
  // Each write carries the generation it read, as a real pass does.
  const next = async (status, extra) => job(status, { ...extra, generation: (await stored(store)).generation });
  for (const status of ["copying", "deleting", "needs_cleanup", "copying"]) {
    assert.equal(await persistMoveJob(store, await next(status, { error: status === "copying" ? "boom" : null })), true);
    assert.equal((await stored(store)).status, status);
  }
  assert.equal(await persistMoveJob(store, await next("complete")), true);
  assert.equal((await stored(store)).status, "complete");
});

test("two passes holding the same generation: the first write wins, the other backs off, finished stays finished", async () => {
  const { store } = world();
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active")));
  const a = job("deleting", { copied: ["a", "b"] });
  const b = job("copying", { copied: ["a"] });
  assert.equal(await persistMoveJob(store, a), true);
  assert.equal(a.generation, 1);
  assert.equal(await persistMoveJob(store, b), false, "B read generation 0 and the job has moved on");
  assert.equal(b.generation, undefined, "a refused write does not change the writer's view");
  const after = await stored(store);
  assert.deepEqual([after.status, after.copied, after.generation], ["deleting", ["a", "b"], 1]);
  // The loser re-reads and carries on from the stored state.
  assert.equal(await persistMoveJob(store, { ...after, status: "needs_cleanup" }), true);
  assert.equal((await stored(store)).generation, 2);
  assert.equal(await persistMoveJob(store, { ...(await stored(store)), status: "complete" }), true);
  assert.equal(await persistMoveJob(store, b), false, "finished moves refuse every writer");
  assert.equal((await stored(store)).status, "complete");
});

test("a store with no conditional write: two writers past the check, one wins and the other reads it back and backs off", async () => {
  const raw = memoryBucket();
  raw.capabilities = { conditionalWrite: false, conditionalCreate: true, conditionalDelete: true };
  const store = withLogicalDelete(raw);
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active")));
  // Both passes finish their check before either puts.
  const put = raw.put.bind(raw);
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  raw.put = async (key, ...rest) => {
    if (key === moveJobKey(ID)) {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    }
    return put(key, ...rest);
  };
  const a = job("deleting", { copied: ["a"] });
  const b = job("copying");
  const results = await Promise.all([persistMoveJob(store, a), persistMoveJob(store, b)]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? a : b;
  const after = await stored(store);
  assert.equal(after.status, winner.status);
  assert.equal(after.generation, 1);
});

// Real passes over a real move. B reads the job, then stalls before touching the
// objects; A advances the move twice; B then fails (its source is gone) and
// tries to record that against the generation it read.
// A finished move rewrites links under the context's privacy manifest, and a
// context without one is "privacy state unavailable": the rewrite pauses.
const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

async function moveWorld() {
  const raw = memoryBucket();
  raw.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  const store = withLogicalDelete(raw);
  await raw.put("privacy.md", MANIFEST);
  return { raw, store };
}
async function seedMove(store, raw) {
  const objects = [];
  for (const name of ["a", "b", "c"]) {
    const source = `1-projects/x/${name}.md`;
    await store.put(source, `# ${name}\n`);
    objects.push({ source, destination: `1-projects/y/${name}.md`, etag: raw.objects.get(source).etag });
  }
  await store.put(moveJobKey(ID), JSON.stringify(job("logical_active", { objects, total_objects: 3 }), null, 2));
}
const audits = (raw) => [...raw.objects.keys()].filter((key) => key.startsWith(".context/audit/")).length;

test("a stale pass cannot regress an advancing move, and the move still completes exactly once", async () => {
  const { raw, store } = await moveWorld();
  await seedMove(store, raw);
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const slow = Object.create(store);
  slow.get = async (key) => {
    if (!key.startsWith(".context/moves/")) await gate;
    return store.get(key);
  };
  const stale = toolMaterializeMove(slow, "private", ID, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.match((await toolMaterializeMove(store, "private", ID, 2)).content[0].text, /copying/);
  assert.match((await toolMaterializeMove(store, "private", ID, 2)).content[0].text, /needs_cleanup/);
  const advanced = await stored(store);
  // Three writes: the copy pass, the write-ahead before the first retirement, the clean-up pass.
  assert.deepEqual([advanced.status, advanced.generation], ["needs_cleanup", 3]);

  open();
  await stale;
  assert.deepEqual(await stored(store), advanced, "the stale pass left the stored job as the advancing pass wrote it");

  // Clean-up now hands over to the reference rewrite, which takes passes of its own.
  let finish = (await toolMaterializeMove(store, "private", ID, 2)).content[0];
  for (let pass = 0; pass < 10 && !/complete/.test(finish.text); pass += 1) {
    finish = (await toolMaterializeMove(store, "private", ID, 2)).content[0];
  }
  assert.match(finish.text, /complete/);
  assert.equal(finish.isError, undefined);
  assert.equal(await stored(store), null);
  for (const name of ["a", "b", "c"]) {
    assert.equal(raw.objects.has(`1-projects/y/${name}.md`), true);
    assert.equal(await store.get(`1-projects/x/${name}.md`), null);
  }
  assert.equal(audits(raw), 1, "the completion is recorded once");
});

test("two passes started together: the move completes once, nothing is lost, and a third pass finds nothing to do", async () => {
  const { raw, store } = await moveWorld();
  await seedMove(store, raw);
  const results = await Promise.all([toolMaterializeMove(store, "private", ID, 100), toolMaterializeMove(store, "private", ID, 100)]);
  // A loser may be paused or told to continue; a follow-up pass settles it.
  for (let pass = 0; pass < 10 && (await stored(store)) !== null; pass += 1) await toolMaterializeMove(store, "private", ID, 100);
  assert.equal(await stored(store), null, "the move finished");
  for (const name of ["a", "b", "c"]) {
    assert.equal(await (await store.get(`1-projects/y/${name}.md`)).text(), `# ${name}\n`);
    assert.equal(await store.get(`1-projects/x/${name}.md`), null);
  }
  assert.equal(audits(raw), 1, "recorded once however the two passes interleave");
  assert.match((await toolMaterializeMove(store, "private", ID, 100)).content[0].text, /not found|no active work/);
});

test("two passes that both reach completion: the clean-up and the audit record run once", async () => {
  const { raw, store } = await moveWorld();
  // Every source is already retired and copied; both passes go straight to finishing.
  const objects = ["a", "b", "c"].map((name) => ({ source: `1-projects/x/${name}.md`, destination: `1-projects/y/${name}.md` }));
  for (const { destination } of objects) await store.put(destination, "# moved\n");
  const copied = objects.map(({ source }) => source);
  await store.put(moveJobKey(ID), JSON.stringify(job("needs_cleanup", { objects, copied, total_objects: 3, copied_objects: 3 })));
  const results = await Promise.all([toolMaterializeMove(store, "private", ID, 100), toolMaterializeMove(store, "private", ID, 100)]);
  // The reference rewrite follows the clean-up in passes of its own; the move is complete once.
  const texts = results.map((r) => r.content[0].text);
  for (let pass = 0; pass < 10 && (await stored(store)) !== null; pass += 1) {
    texts.push((await toolMaterializeMove(store, "private", ID, 100)).content[0].text);
  }
  assert.equal(texts.filter((text) => /physical storage sync: complete/.test(text)).length, 1);
  assert.equal(audits(raw), 1);
  assert.equal(await stored(store), null);
});
