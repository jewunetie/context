/**
 * The linking guidance (AGENT-LINKS 13.2, Task 24): the connect-time
 * instructions and the listed `write_note` description each carry it, so a
 * client that delivers only one of them still gets it. Driven through the real
 * worker: `initialize` with a bucket the sketch reads, then `tools/list`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *   the sentence removed from the write_note description     1 (description)
 *   the bullet removed from INSTRUCTIONS_BODY                1 (instructions)
 *   the retired sentence put back in the description          1 (description)
 *   the new back-link phrase dropped from the description     1 (description)
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createBucket, createControlPlaneStub, rpc } from "./orientation/fixtures.mjs";

const TOKEN = `cat_link_guidance_owner_${"0".repeat(12)}`;
const flat = (s) => String(s ?? "").replace(/\s+/g, " ");

// The 13.2 substance, phrase by phrase, so dropping any one part fails.
const PHRASES = [
  "Preserve existing useful references",
  "link it where that relationship is stated",
  "optional leads, not verified relationships",
  "read enough of a candidate to confirm it",
  "skip topic-only matches",
  "add a link back where the relationship is real",
];
// Owner decision (2026-10-07): the old prohibition is gone everywhere.
const RETIRED = "do not rewrite a note just to add links";
const missing = (text) => [...PHRASES.filter((p) => !flat(text).includes(p)), ...(flat(text).includes(RETIRED) ? [`retired: ${RETIRED}`] : [])];

let restore;
let env;

before(async () => {
  const controlPlane = createControlPlaneStub();
  restore = controlPlane.install();
  const bucket = createBucket();
  bucket.seed("index.md", "# Context\n\nShipping the gateway.\n");
  controlPlane.addWorkspace("ws_link_guidance", "link-guidance", {
    provider: "r2-binding",
    bindingName: "GUIDANCE_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: "ws_link_guidance",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_link_guidance",
    userId: "user_link_guidance",
  });
  env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, NATIVE_BINDINGS: "GUIDANCE_BUCKET", GUIDANCE_BUCKET: bucket };
});

after(() => restore?.());

test("initialize instructions carry the linking guidance", async () => {
  const { body } = await rpc(env, TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  const instructions = body?.result?.instructions;
  assert.ok(flat(instructions).includes("Shipping the gateway."), "the live sketch, not the static fallback");
  assert.deepEqual(missing(instructions), []);
});

test("the listed write_note description carries the linking guidance", async () => {
  const { body } = await rpc(env, TOKEN, "tools/list", {});
  const writeNote = body?.result?.tools?.find((t) => t.name === "write_note");
  assert.ok(writeNote, "write_note is listed");
  assert.deepEqual(missing(writeNote.description), []);
});
