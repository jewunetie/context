/**
 * SEARCH_GRAPH_BOOST wiring (Task 29 fix round 1, OPEN-68): route.js resolves
 * the deployment var onto `store.searchGraphBoost` for the session's own store
 * and for every cross-context store, and anything but "b2", "b3", "b4" or "ppr" is
 * off. Driven through the Worker. The graph's kill switch
 * (WRITE_ENRICH_SUBREQUEST_BUDGET "0") is set throughout, so a boosted search
 * always withholds the graph and says so: the label is present exactly when
 * the boost reached the store.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   session store not given the boost                       2 (own context; cross-context copies it)
 *   cross-context store not given the boost                 1 (cross-context)
 *   raw value at route.js and a lax graphBoost together     1 (invalid values)
 *
 * The raw value at route.js alone is not caught: searchVisibleNotes checks it
 * again through the same graphBoost.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-boost.test";
const OWNER = `cat_boost_owner_${"0".repeat(24)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, WRITE_ENRICH_SUBREQUEST_BUDGET: "0" };
const LABEL = /link-based ranking was unavailable/;

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEGB",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEGB",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function call(name, args) {
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
  return body?.result?.content?.[0]?.text || "";
}

const restore = [];
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.addWorkspace("ws_boost_me", "boostme", binding("boost-me"));
  controlPlane.addWorkspace("ws_boost_team", "boostteam", binding("boost-team"));
  await controlPlane.addGrant({
    workspaceId: "ws_boost_me",
    userId: "user_boost",
    accessToken: OWNER,
    scopes: ["context:read", "context:write", "context:private"],
    alsoMemberOf: [{ workspaceId: "ws_boost_team", role: "owner" }],
  });
  for (const context of [undefined, "@boostteam"]) {
    await call("write_note", { path: "2-areas/kestrel.md", content: "# Kestrel\n\nThe kestrel plan.\n", ...(context && { context }) });
    // Until the index answers (no scan banner), with the boost off.
    for (let i = 0; i < 5; i += 1) await call("search_notes", { query: "kestrel", ...(context && { context }) });
  }
});
after(() => {
  for (const undo of restore.reverse()) undo();
});

async function searchWith(value, context) {
  if (value === undefined) delete env.SEARCH_GRAPH_BOOST;
  else env.SEARCH_GRAPH_BOOST = value;
  try {
    return await call("search_notes", { query: "kestrel", ...(context && { context }) });
  } finally {
    delete env.SEARCH_GRAPH_BOOST;
  }
}

test("own context: SEARCH_GRAPH_BOOST b2, b3, b4 and ppr reach the session store", async () => {
  assert.match(await searchWith(undefined), /^1 matching note\n\n2-areas\/kestrel\.md/, "positive control: an indexed hit");
  for (const value of ["b2", "b3", "b4", "ppr"]) assert.match(await searchWith(value), LABEL, value);
});

test("cross-context: the boost reaches a store opened with context", async () => {
  assert.match(await searchWith(undefined, "@boostteam"), /^1 matching note\n\n2-areas\/kestrel\.md/, "positive control");
  assert.match(await searchWith("b2", "@boostteam"), LABEL);
});

test("invalid values mean off, on both stores", async () => {
  for (const value of [undefined, "off", "B2", " b2", "b5", "", "true", "PPR", "ppr "]) {
    assert.doesNotMatch(await searchWith(value), LABEL, String(value));
    assert.doesNotMatch(await searchWith(value, "@boostteam"), LABEL, String(value));
  }
});
