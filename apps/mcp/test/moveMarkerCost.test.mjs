/**
 * Finished move markers cost nothing per request (pre-existing issue 7).
 *
 * A finished move's marker delete is a logical-delete tombstone that is never
 * removed, so `.context/moves/` only grows. Every request that lists it
 * (`read_note`, `related_notes`, indexed moves, suggestions) paid one raw read
 * per tombstone, inside the logical-delete wrapper's listing and outside every
 * budget: after a few dozen moves a Workers Free invocation (50 subrequests)
 * was over its limit. The listing now recognises a tombstone by its size, as
 * the wrapper already does, without reading it.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   the move-marker listing without the size shortcut (old behavior)   1 here, 1 in graphSuggest, 1 in relatedNotesTool
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { activeMoveJobsOrNull, moveJobKey, refreshMoveSentinel, writeMoveSentinel } from "../src/moves/jobs.js";
import { MOVE_SENTINEL_KEY } from "../src/moves/limits.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { memoryBucket } from "./store/fixtures.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER = `cat_cost_owner_${"0".repeat(17)}`;
const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const CAPS = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };

const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  NATIVE_BINDINGS: "COST_BUCKET",
  SEARCH_SUBREQUEST_BUDGET: "50",
  WRITE_ENRICH_SUBREQUEST_BUDGET: "0",
};

let restore;
before(async () => {
  const controlPlane = createControlPlaneStub();
  restore = controlPlane.install();
  controlPlane.addWorkspace("ws_cost", "cost", { provider: "r2-binding", bindingName: "COST_BUCKET", capabilities: CAPS, status: "active" });
  await controlPlane.addGrant({
    accessToken: OWNER, workspaceId: "ws_cost", role: "owner",
    scopes: ["context:read", "context:write", "context:private"], clientId: "mcp_client_cost", userId: "user_cost",
  });
});
after(() => restore?.());

/** Every raw storage call the worker makes on `store`. */
function recording(store) {
  const log = [];
  const wrap = (name) => (...args) => (log.push(`${name}:${String(args[0]?.prefix ?? args[0])}`), store[name](...args));
  return { ...store, get: wrap("get"), put: wrap("put"), list: wrap("list"), delete: wrap("delete"), head: store.head && wrap("head"), log };
}

const jobBody = (id, status) =>
  JSON.stringify({
    version: 1, id, status, source: "1-projects/x", destination: "1-projects/y", created_at: "2026-01-01",
    updated_at: "2026-01-01", total_objects: 0, copied_objects: 0, deleted_objects: 0, copied: [], objects: [], error: null,
  }, null, 2);

/** A bucket with `finished` completed moves behind it, made as materialize_move makes them. */
async function world(finished, { active = false } = {}) {
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  const wrapped = withLogicalDelete(raw);
  await raw.put("privacy.md", MANIFEST);
  await raw.put("1-projects/seed.md", "# Seed\n\nA plain note.\n");
  for (let i = 0; i < finished; i += 1) {
    const id = `move-${String(i).padStart(13, "0")}`;
    await writeMoveSentinel(wrapped);
    await wrapped.put(moveJobKey(id), jobBody(id, "logical_active"));
    await wrapped.put(moveJobKey(id), jobBody(id, "complete"));
    await wrapped.delete(moveJobKey(id));
    await refreshMoveSentinel(wrapped);
  }
  if (active) {
    await writeMoveSentinel(wrapped);
    await wrapped.put(moveJobKey("move-active-00001"), jobBody("move-active-00001", "logical_active"));
    await writeMoveSentinel(wrapped);
  }
  return raw;
}

async function call(raw, name, args) {
  const rec = recording(raw);
  env.COST_BUCKET = rec;
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body.result?.content?.[0]?.text ?? "", ops: rec.log.length, moveOps: rec.log.filter((op) => op.includes(".context/moves/")).length };
}

const TOOLS = [
  ["read_note", { path: "1-projects/seed.md" }],
  ["related_notes", { path: "1-projects/seed.md" }],
  ["write_note", { path: "1-projects/new.md", content: "# New\n\nAnother plain note.\n" }],
];

test("after 50 completed moves a read, related_notes and a plain write cost what they cost with no history", async () => {
  const none = await world(0);
  const history = await world(50);
  assert.ok([...history.objects.keys()].filter((k) => k.startsWith(".context/moves/move-")).length >= 50, "the tombstones are there");
  const rows = [];
  for (const [name, args] of TOOLS) {
    const before = await call(none, name, args);
    const after = await call(history, name, args);
    assert.ok(!/error|not found/i.test(before.text), `${name}: ${before.text}`);
    rows.push({ name, before, after });
    console.log(`# ${name}: ${before.ops} ops with no history (${before.moveOps} on move markers), ${after.ops} after 50 moves (${after.moveOps})`);
  }
  for (const { name, before, after } of rows) {
    assert.equal(after.ops, before.ops, `${name} total ops`);
    assert.equal(after.moveOps, before.moveOps, `${name} move-marker ops`);
    assert.ok(after.ops <= 50, `${name} stays inside the Workers Free limit (${after.ops})`);
  }
});

test("an active move among the history is still found, with its sentinel", async () => {
  const raw = await world(50, { active: true });
  const wrapped = withLogicalDelete(raw);
  const jobs = await activeMoveJobsOrNull(wrapped);
  assert.deepEqual(jobs.map((job) => job.id), ["move-active-00001"]);
  assert.ok(raw.objects.has(MOVE_SENTINEL_KEY));
  assert.equal(JSON.parse(raw.objects.get(moveJobKey("move-active-00001")).body).status, "logical_active");
});

test("a real marker is never the size of a tombstone", async () => {
  // The listing skips objects of exactly the tombstone's size without reading
  // them. The smallest job the gateway writes is far above it.
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  const wrapped = withLogicalDelete(raw);
  const id = "move-0000000000000";
  await wrapped.put(moveJobKey(id), jobBody(id, "logical_active"));
  const live = raw.objects.get(moveJobKey(id)).body.length;
  await wrapped.delete(moveJobKey(id));
  const tomb = raw.objects.get(moveJobKey(id)).body.length;
  assert.ok(live > tomb * 2, `${live} vs ${tomb}`);
});

test("every unfinished status is found among 50 tombstones: nothing a move still needs is dropped", async () => {
  const raw = await world(50);
  const wrapped = withLogicalDelete(raw);
  const statuses = ["logical_active", "copying", "deleting", "needs_cleanup"];
  for (const [at, status] of statuses.entries()) {
    const id = `move-live-${String(at).padStart(6, "0")}`;
    await wrapped.put(moveJobKey(id), jobBody(id, status));
  }
  const found = (await activeMoveJobsOrNull(wrapped)).map((job) => job.status).sort();
  assert.deepEqual(found, [...statuses].sort());
});

test("a listing that reports no sizes still proves each tombstone with a read", async () => {
  const raw = await world(5, { active: true });
  const noSizes = Object.assign(Object.create(raw), {
    list: async (options) => {
      const page = await raw.list(options);
      return { ...page, objects: page.objects.map(({ size: _size, ...rest }) => rest) };
    },
  });
  const jobs = await activeMoveJobsOrNull(withLogicalDelete(noSizes));
  assert.deepEqual(jobs.map((job) => job.id), ["move-active-00001"]);
});
