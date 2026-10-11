/**
 * The console's related notes (Task 18): the `related` file operation, which
 * runs the gateway's own `retrieveCandidates` over this runtime's store, and
 * the `relatedNotes` action that reaches it.
 *
 * Fixtures build the graph with the gateway's `projectNote` and converge the
 * search index with `maintainSearchIndex`, so every reason comes from the
 * stores the operation reads.
 *
 * What is asserted, and why:
 *
 *  - **A member's relations are filtered by their own clearance.** A private
 *    note that the seed links to, that links back, and that shares its words
 *    never appears in a team caller's answer, in any field.
 *  - **A note outside the caller's clearance is the read operation's
 *    not-found**, byte for byte, the same as a path that never existed.
 *  - **Nothing in a team answer varies with hidden notes** (invariance).
 *  - `missing` is said only over a complete catalog; `possiblyIncomplete` is
 *    true on a best-effort store and false only with a conditional store and a
 *    swept graph.
 *  - **Cross-surface (DELIVERY 18.1):** the public action's real serialized
 *    answer passes the action's own `returns` validator (convex-test enforces
 *    it), and then goes through the console's own reader,
 *    `parseRelatedAnswer` (Task 19), which must accept it unchanged.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted. Counts are failing tests here.
 *
 *   candidate filter admits every path (canSee dropped)   2 (clearance filter, invariance)
 *   Convex WRITE_ENRICH_SUBREQUEST_BUDGET ignored          5 (off switch, four spellings)
 *   exact "0" match instead of writeEnrichBudgetFor        4 (four spellings)
 *
 * RED: 5 of 6 failed before the operation existed; the not-found test passed
 * then only because an unknown operation fails the same way for every path.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { type Clearance, clearanceOf } from "../functions/lib/clearance";
import { type FileStore, maintainSearchIndex } from "../functions/lib/fileOps";
import { executeOperation } from "../functions/lib/filesFns/executeOperation";
import { isPlumbing } from "../functions/lib/privacy";
import { initGraphManifest } from "../../mcp/src/graph/manifest.js";
import { graphManifestKey } from "../../mcp/src/graph/keys.js";
import { projectNote } from "../../mcp/src/graph/project.js";
import { createSearchBudget } from "../../mcp/src/search/maintain.js";
import { parseRelatedAnswer } from "../../mobile/features/console/files/browser/relatedAnswer";
import { indexIsBehind, loadIndexManifest, syncShardedIndex } from "../../mcp/src/search/shards.js";
import { bucket, shareProjects } from "./fileOps/fixtures.helpers";
import { asUser, captureError } from "./fixtures.helpers";
import { errorShape, fixture, share } from "./files/fixtures.helpers";

const NOW = 1_800_000_000_000;
const SEED = "1-projects/kestrel.md";
const team = clearanceOf("team");
const owner = clearanceOf("private");
const big = () => createSearchBudget(100_000);
const indexable = (key: string) => key.endsWith(".md") && !isPlumbing(key);
type AnyStore = Parameters<typeof projectNote>[0];

/** Visible to a team caller once `1-projects` is shared. */
const VISIBLE: Record<string, string> = {
  [SEED]: "# Kestrel migration\n\nSee [plan](plan.md), [pay](pay.md) and [gone](gone.md).\nThe kestrel harbor cutover.\n",
  "1-projects/plan.md": "# Plan\n\nkestrel harbor steps\n",
  "1-projects/notes.md": "# Notes\n\nThe kestrel harbor cutover went fine.\n",
};
/** Private: a link target of the seed, a backlink, and text matches. */
const HIDDEN: Record<string, string> = {
  "1-projects/pay.md": "# Pay\n\nkestrel harbor salaries, see [k](kestrel.md)\n",
  "2-areas/secret.md": "# Secret\n\nkestrel harbor cutover [k](../1-projects/kestrel.md)\n",
  "2-areas/other.md": "# Other\n\nkestrel kestrel harbor harbor cutover\n",
};

/** A bucket holding `notes`, their graph projections and a converged index. */
async function world(
  notes: Record<string, string>,
  { conditional = false, ready = false, graph = true, index = true } = {},
): Promise<FileStore> {
  const store = bucket({ conditional });
  await store.delete("1-projects/pay.md");
  await shareProjects(store);
  for (const [path, body] of Object.entries(notes)) await store.put(path, body);
  if (graph) {
    const s = store as unknown as AnyStore;
    await initGraphManifest(s, big(), { mode: "conditional", now: NOW });
    for (const [path, body] of Object.entries(notes)) {
      const { state } = await projectNote(s, path, body, "1", { budget: big(), gen: "1", mode: "conditional", now: NOW, read: undefined });
      expect(state, path).toBe("projected");
    }
    if (ready) {
      const m = JSON.parse(await (await store.get(graphManifestKey()))!.text());
      await store.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "ready", sweepComplete: true } }));
    }
  }
  if (index) {
    for (let pass = 0; pass < 20; pass += 1) if ((await maintainSearchIndex(store)).complete) break;
  }
  return store;
}

const related = (store: FileStore, clearance: Clearance, path = SEED) =>
  executeOperation(store, clearance, { kind: "related", path }, NOW);

async function failure(fn: () => Promise<unknown>): Promise<string> {
  return errorShape(await captureError(fn));
}

describe("the related operation", () => {
  test("a team member's relations are filtered by their clearance; the owner's are not", async () => {
    const store = await world({ ...VISIBLE, ...HIDDEN });
    const asOwner = await related(store, owner);
    const asTeam = await related(store, team);
    if (asOwner.kind !== "related" || asTeam.kind !== "related") throw new Error("not a related answer");

    const ownerPaths = asOwner.relations.map((r) => r.path);
    expect(ownerPaths).toContain("1-projects/pay.md");
    expect(ownerPaths).toContain("2-areas/secret.md");

    const teamPaths = asTeam.relations.map((r) => r.path);
    expect(teamPaths).toContain("1-projects/plan.md");
    expect(teamPaths).toContain("1-projects/notes.md");
    expect(teamPaths).not.toContain(SEED);
    for (const hidden of Object.keys(HIDDEN)) expect(teamPaths).not.toContain(hidden);
    expect(JSON.stringify(asTeam)).not.toContain("secret");
    expect(JSON.stringify(asTeam)).not.toContain("other.md");
    expect(JSON.stringify(asTeam)).not.toContain("salaries");
  });

  test("a note outside the caller's clearance is the read operation's not-found, byte for byte", async () => {
    const store = await world({ ...VISIBLE, ...HIDDEN });
    const hidden = await failure(() => related(store, team, "2-areas/secret.md"));
    const absent = await failure(() => related(store, team, "2-areas/never.md"));
    const read = await failure(() => executeOperation(store, team, { kind: "read", path: "2-areas/never.md" }, NOW));
    expect(hidden).toBe(absent);
    expect(hidden).toBe(read);
    expect(hidden).toContain("FILE_NOT_FOUND");
  });

  test("a team answer does not vary with hidden notes", async () => {
    const without = await related(await world(VISIBLE, { conditional: true, ready: true }), team);
    const withHidden = await related(await world({ ...VISIBLE, ...HIDDEN }, { conditional: true, ready: true }), team);
    // Not vacuous: the shared answer carries a graph reason and a text reason.
    expect(JSON.stringify(without)).toContain("linked_from_here");
    expect(JSON.stringify(without)).toContain("related_text");
    expect(JSON.stringify(withHidden)).toBe(JSON.stringify(without));
  });

  test("unresolved carries missing only when the catalog is complete", async () => {
    const store = await world(VISIBLE, { conditional: true, ready: true });
    const converged = await related(store, team);
    if (converged.kind !== "related") throw new Error("not a related answer");
    // pay.md is absent here; gone.md never existed. Both are the seed's own text.
    expect(converged.unresolved.map((u) => [u.target, u.state])).toEqual([["pay.md", "missing"], ["gone.md", "missing"]]);

    await store.put("2-areas/new.md", "a hidden edit");
    await syncShardedIndex(store as unknown as AnyStore, { budget: createSearchBudget(3), isIndexable: indexable });
    expect(indexIsBehind((await loadIndexManifest(store as unknown as AnyStore, big(), 0)).freshness)).toBe(true);
    const behind = await related(store, team);
    if (behind.kind !== "related") throw new Error("not a related answer");
    expect(behind.unresolved.map((u) => u.state)).toEqual(["unknown", "unknown"]);
    expect(behind.relations).toEqual(converged.relations);

    const noIndex = await related(await world(VISIBLE, { index: false }), team);
    if (noIndex.kind !== "related") throw new Error("not a related answer");
    // No catalog at all: even plan.md, which exists, is not known to.
    expect(noIndex.unresolved.map((u) => [u.target, u.state])).toEqual([["plan.md", "unknown"], ["pay.md", "unknown"], ["gone.md", "unknown"]]);
  });

  test("possiblyIncomplete is true on a best-effort store and false on a swept conditional one", async () => {
    const bestEffort = await related(await world(VISIBLE, { ready: true }), team);
    expect(bestEffort).toMatchObject({ kind: "related", possiblyIncomplete: true });
    const swept = await world(VISIBLE, { conditional: true, ready: true });
    expect(await related(swept, team)).toMatchObject({ kind: "related", possiblyIncomplete: false });
    expect(await related(swept, owner)).toMatchObject({ kind: "related", possiblyIncomplete: false });
  });
});

describe("the console's off switch", () => {
  test("WRITE_ENRICH_SUBREQUEST_BUDGET=0 skips the graph: own links kept, links_here gone, labelled incomplete", async () => {
    const store = await world({ ...VISIBLE, ...HIDDEN }, { conditional: true, ready: true });
    const on = JSON.stringify(await related(store, owner));
    // Not vacuous: with the graph on, a backlink reason and a complete answer.
    expect(on).toContain("links_here");
    expect(on).toContain('"possiblyIncomplete":false');
    vi.stubEnv("WRITE_ENRICH_SUBREQUEST_BUDGET", "0");
    try {
      const off = await related(store, owner);
      expect(JSON.stringify(off)).not.toContain("links_here");
      expect(JSON.stringify(off)).toContain("linked_from_here");
      expect(off).toMatchObject({ kind: "related", possiblyIncomplete: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test.each(["0.5", " 0", "0.0", "-1"])("WRITE_ENRICH_SUBREQUEST_BUDGET=%j is read as the gateway reads it: off", async (value) => {
    const store = await world({ ...VISIBLE, ...HIDDEN }, { conditional: true, ready: true });
    vi.stubEnv("WRITE_ENRICH_SUBREQUEST_BUDGET", value);
    try {
      const off = await related(store, owner);
      expect(JSON.stringify(off)).not.toContain("links_here");
      expect(off).toMatchObject({ kind: "related", possiblyIncomplete: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the relatedNotes action", () => {
  test("a member's real serialized answer passes the returns validator; a hidden note is the read's not-found", async () => {
    const f = await fixture();
    await share(f);
    f.backend.seed("1-projects/shared.md", "# Shared\n\nkestrel harbor cutover, see [gone](gone.md)\n");
    f.backend.seed("1-projects/plan.md", "# Plan\n\nkestrel harbor steps\n");
    await f.t.action(internal.functions.files.runFileOperation, {
      workspaceId: f.workspaceId,
      scope: "private",
      operation: { kind: "maintainIndex" },
    });
    const as = asUser(f.t, f.reader);

    // convex-test validates the action's `returns` against this value.
    const answer = await as.action(api.functions.files.relatedNotes, { workspaceId: f.workspaceId, path: "1-projects/shared.md" });
    const serialized = JSON.parse(JSON.stringify(answer));
    expect(serialized.kind).toBe("related");
    expect(serialized.relations.map((r: { path: string }) => r.path)).toContain("1-projects/plan.md");
    expect(serialized.possiblyIncomplete).toBe(true);
    // DELIVERY 18.1: the console's reader takes this exact value, nothing dropped or renamed.
    expect(serialized.unresolved.length).toBeGreaterThan(0);
    const { kind: _kind, ...carried } = serialized;
    expect(parseRelatedAnswer(serialized)).toEqual(carried);

    const hidden = await failure(() => as.action(api.functions.files.relatedNotes, { workspaceId: f.workspaceId, path: "2-areas/private-note.md" }));
    const absent = await failure(() => as.action(api.functions.files.relatedNotes, { workspaceId: f.workspaceId, path: "2-areas/never.md" }));
    const read = await failure(() => as.action(api.functions.files.readNote, { workspaceId: f.workspaceId, path: "2-areas/never.md" }));
    expect(hidden).toBe(absent);
    expect(hidden).toBe(read);
  });
});
