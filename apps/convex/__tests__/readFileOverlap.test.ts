/**
 * Opening a note is asked for only after `privacy.md` has answered.
 *
 * Owner, 2026-10-11, added an early GET of the note that overlapped
 * `privacy.md`. Owner decision (option b, link-graph stack re-integration):
 * that early GET is dropped on purpose. It made a hidden path cost one storage
 * call and a missing one the same only by fetching a hidden note's bytes, and
 * phase 5's rule is that those bytes are never fetched for a caller who may not
 * read them (`moveOverlay.test.ts`, "a hidden path costs what an absent path
 * costs"). These tests now pin the new order and that nothing leaves.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, readFile, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function bucket(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/plan.md", "# Plan\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

/** Hold `privacy.md`'s GET until released, recording every key asked for. */
function holdPrivacy(store: FileStore) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const get = store.get.bind(store);
  store.get = (async (key: string) => {
    asked.push(key);
    if (key === PRIVACY_KEY) await gate;
    return get(key);
  }) as FileStore["get"];
  return { asked, release: () => release() };
}

async function capture(read: () => Promise<unknown>) {
  try {
    await read();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

describe("readFile asks for the note after privacy.md", () => {
  test("the note is not asked for before privacy.md has answered", async () => {
    const store = await bucket();
    const held = holdPrivacy(store);
    const reading = readFile(store, { path: "1-projects/plan.md", clearance: TEAM });
    await Promise.resolve();
    expect(held.asked).toContain(PRIVACY_KEY);
    expect(held.asked).not.toContain("1-projects/plan.md");
    held.release();
    await expect(reading).resolves.toMatchObject({ text: "# Plan\n" });
    expect(held.asked).toContain("1-projects/plan.md");
  });

  test("a note held back is refused exactly as a missing one, and its bytes are never fetched", async () => {
    const store = await bucket();
    const held = holdPrivacy(store);
    held.release();
    const hidden = await capture(() => readFile(store, { path: "1-projects/pay.md", clearance: TEAM }));
    expect(held.asked).not.toContain("1-projects/pay.md");
    const missing = await capture(() => readFile(store, { path: "1-projects/nothing.md", clearance: TEAM }));
    expect(hidden.code).toBe("FILE_NOT_FOUND");
    expect({ code: hidden.code, message: hidden.message }).toEqual({ code: missing.code, message: missing.message });
    expect(JSON.stringify(hidden)).not.toContain("salaries");
  });
});
