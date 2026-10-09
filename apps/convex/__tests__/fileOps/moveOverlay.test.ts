/**
 * The console read applies the gateway's move overlay (pre-existing issue 2),
 * and a hidden path costs what an absent one costs (issue 6).
 * A note caught mid-move into a path the caller cannot see is not served at its
 * source, a half-moved note reads at its destination, and an unreadable move
 * state reads as not found.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   the overlay removed from `readVisibleFile` (plain `store.get(path)`)   4 here
 *   the hidden path's metadata probe removed (refusal before any storage call)    1 here (issue 6)
 */

import { describe, expect, test } from "vitest";

import { clearanceOf } from "../../functions/lib/clearance";
import { readFile, readFiles } from "../../functions/lib/fileOps";
import { bucket, capture, errorShape, shareProjects } from "./fixtures.helpers";

const ID = "job-0000000000001";
const job = (destination: string) =>
  JSON.stringify({
    version: 1,
    id: ID,
    source: "1-projects/mv",
    destination,
    status: "logical_active",
    created_at: "2026-01-01",
    objects: [{ source: "1-projects/mv/a.md", destination: `${destination}/a.md` }],
  });

async function moving(destination: string) {
  const store = bucket();
  await shareProjects(store);
  store.seed("1-projects/mv/a.md", "# Moving\n\nsecret plan\n");
  store.seed(`.context/moves/${ID}.json`, job(destination));
  return store;
}

const TEAM = clearanceOf("team");
const OWNER = clearanceOf("private");

describe("the console read honours an in-flight logical move", () => {
  test("a team caller is not served a note moving into a private folder, at either address", async () => {
    const store = await moving("2-areas/mv");
    const atSource = await capture(() => readFile(store, { path: "1-projects/mv/a.md", clearance: TEAM }));
    const atDestination = await capture(() => readFile(store, { path: "2-areas/mv/a.md", clearance: TEAM }));
    const absent = await capture(() => readFile(store, { path: "1-projects/never.md", clearance: TEAM }));
    expect(atSource.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(atSource)).toBe(errorShape(absent));
    expect(errorShape(atDestination)).toBe(errorShape(absent));
    const batch = await readFiles(store, { paths: ["1-projects/mv/a.md"], clearance: TEAM });
    expect(batch[0]).toMatchObject({ outcome: "error", code: "FILE_NOT_FOUND" });
  });

  test("a half-moved note reads at its destination from the source bytes", async () => {
    const store = await moving("1-projects/moved");
    const read = await readFile(store, { path: "1-projects/moved/a.md", clearance: TEAM });
    expect(read.path).toBe("1-projects/moved/a.md");
    expect(read.text).toContain("secret plan");
    // Non-vacuous: the owner is served it at the destination too.
    expect((await readFile(store, { path: "1-projects/moved/a.md", clearance: OWNER })).text).toContain("secret plan");
  });

  test("a move the caller cannot see the source of is not served from the source", async () => {
    const hiddenSource = bucket();
    await shareProjects(hiddenSource);
    hiddenSource.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
    hiddenSource.seed("1-projects/moved/pay.md", "# Pay\n\nsalaries\n"); // copied, source not yet retired
    hiddenSource.seed(
      `.context/moves/${ID}.json`,
      JSON.stringify({
        version: 1, id: ID, source: "1-projects/pay-dir", destination: "1-projects/moved", status: "logical_active",
        created_at: "2026-01-01", objects: [{ source: "1-projects/pay.md", destination: "1-projects/moved/pay.md" }],
      }),
    );
    const error = await capture(() => readFile(hiddenSource, { path: "1-projects/moved/pay.md", clearance: TEAM }));
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  test("an unreadable move state reads as not found", async () => {
    const store = await moving("1-projects/moved");
    store.seed("1-projects/plain.md", "# Plain\n");
    const failing = Object.assign(Object.create(store), {
      list: (options: { prefix?: string }) =>
        options?.prefix === ".context/moves/" ? Promise.reject(new Error("list failed")) : store.list(options as never),
    });
    const error = await capture(() => readFile(failing, { path: "1-projects/plain.md", clearance: TEAM }));
    expect(error.code).toBe("FILE_NOT_FOUND");
  });
});

describe("a hidden path costs what an absent path costs", () => {
  /** Every storage call a read makes, as `method:key`, with the asked path replaced. */
  async function ops(store: Parameters<typeof readFile>[0], path: string) {
    const log: string[] = [];
    const recording = new Proxy(store, {
      get(target, name, receiver) {
        const member = Reflect.get(target, name, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const first = args[0] as { prefix?: string } | string | undefined;
          const key = typeof first === "string" ? first : (first?.prefix ?? "");
          // A metadata probe and a read are the same one storage call here.
          const about = key.replaceAll(path, "<P>");
          log.push(about === "<P>" ? "object" : `${String(name)}:${about}`);
          return member.apply(target, args);
        };
      },
    });
    const error = await capture(() => readFile(recording, { path, clearance: TEAM }));
    return { error: errorShape(error), log: log.filter((entry) => !entry.includes("privacy.md")) };
  }

  test("a held-back note and a missing one make the same storage calls", async () => {
    const store = bucket();
    await shareProjects(store); // 1-projects/pay.md is held back by name
    store.seed("2-areas/health.md", "# Health\n");
    for (const [hidden, absent] of [
      ["1-projects/pay.md", "1-projects/never.md"],
      ["2-areas/health.md", "2-areas/never.md"],
    ]) {
      const a = await ops(store, hidden);
      const b = await ops(store, absent);
      expect(a.log.length).toBeGreaterThan(0);
      expect(a).toEqual(b);
    }
  });

  test("a hidden move destination and a missing path make the same storage calls", async () => {
    const store = await moving("2-areas/mv");
    expect(await ops(store, "2-areas/mv/a.md")).toEqual(await ops(store, "2-areas/never.md"));
  });
});
