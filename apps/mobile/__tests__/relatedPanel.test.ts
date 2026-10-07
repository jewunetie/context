/**
 * @jest-environment jsdom
 */

/**
 * The note view's "Linked here / Related" panel (link-graph Task 19, P7,
 * arch 14), and the answer parser it reads `functions/files.relatedNotes`
 * through.
 *
 * What is asserted, and why:
 *
 *  - **The parser rejects a malformed answer** rather than drawing part of
 *    one: a field the panel would print must be the field the action sent.
 *    All five unresolved states are accepted, `invalid` included (Task 18).
 *  - **Loading, offline, unavailable and "may be incomplete" are four
 *    different screens**, and none of them is "No linked or related notes":
 *    a list still on its way, a list nobody could ask for, and a list the
 *    index may not have finished are not a confidently empty one (arch 14).
 *  - **Reasons and unresolved states are words**, never the wire's enums.
 *  - **Evidence is untrusted note text** and arrives as plain text.
 *  - **UI reachability (DELIVERY 18.1):** the panel is under a real note in
 *    the whole mounted console at phone and pointer widths, and a row opens
 *    the note through the browser's own `select`.
 *
 * The cross-surface half (the action's real serialized answer through
 * `parseRelatedAnswer`) is in `apps/convex/__tests__/relatedNotes.test.ts`,
 * where convex-test can produce that answer.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   the empty sentence drawn while loading   "loading never says ..." fails
 *
 * RED: the suite failed to load before `relatedAnswer.ts` existed; with the
 * parser and panel written, both reachability tests failed until
 * `BrowseDocument` handed the panel to the note.
 *
 * The phone test mounts the whole console, which on a case-insensitive disk
 * (macOS default) resolves `home/PhoneBack` to `phoneBack.ts` and fails for
 * every phone mount in `noteChrome/`, before and after this change. It passes
 * on a case-sensitive volume, as CI's is.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dataWith, mountConsole, NOTE } from "./noteChrome/fixtures";
import { parseRelatedAnswer, type RelatedAnswer } from "../features/console/files/browser/relatedAnswer";
import { RelatedPanel } from "../features/console/panes/browsePane/RelatedPanel";
import type { FileBrowser } from "../features/console/files/browser";

const ANSWER: RelatedAnswer = {
  relations: [
    { path: "1-projects/back.md", reasons: ["links_here"] },
    { path: "1-projects/plan-b.md", reasons: ["linked_from_here", "shares_target"] },
    { path: "3-resources/web.md", reasons: ["shares_url", "related_text", "nearby"], evidence: "<script>alert(1)</script>" },
  ],
  unresolved: [
    { target: "gone.md", start: 10, end: 17, state: "missing" },
    { target: "twin", start: 20, end: 24, state: "ambiguous" },
    { target: "ftp://x", start: 30, end: 37, state: "unsupported" },
    { target: "bad%zz", start: 40, end: 46, state: "invalid" },
    { target: "later.md", start: 50, end: 58, state: "unknown" },
  ],
  possiblyIncomplete: false,
};

const wire = (answer: RelatedAnswer) => JSON.parse(JSON.stringify({ kind: "related", ...answer })) as unknown;

describe("parseRelatedAnswer", () => {
  test("accepts the action's shape, with all five unresolved states", () => {
    expect(parseRelatedAnswer(wire(ANSWER))).toEqual(ANSWER);
  });

  test("rejects a malformed result", () => {
    const good = wire(ANSWER) as Record<string, unknown>;
    const bad: unknown[] = [
      null,
      "related",
      { ...good, kind: "searched" },
      { ...good, possiblyIncomplete: "no" },
      { ...good, relations: {} },
      { ...good, relations: [{ path: 3, reasons: [] }] },
      { ...good, relations: [{ path: "a.md", reasons: ["links_there"] }] },
      { ...good, relations: [{ path: "a.md", reasons: ["links_here"], evidence: 1 }] },
      { ...good, unresolved: [{ target: "x", start: 0, end: 1, state: "broken" }] },
      { ...good, unresolved: [{ target: "x", start: "0", end: 1, state: "missing" }] },
      { kind: "related", relations: [], unresolved: [] },
    ];
    for (const raw of bad) expect(() => parseRelatedAnswer(raw)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */

type Related = NonNullable<FileBrowser["relatedNotes"]>;

function mountPanel(relatedNotes: Related | undefined, reachability: "online" | "offline" = "online") {
  const onOpen = jest.fn<(path: string) => void>();
  const files = {
    relatedNotes,
    sync: { reachability, counts: { pending: 0, failed: 0, conflicts: 0 }, durable: true },
  } as unknown as FileBrowser;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(RelatedPanel, { files, path: NOTE, onOpen })));
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    container,
    find,
    onOpen,
    text: () => container.textContent ?? "",
    unmount: () => act(() => root.unmount()),
  };
}

const settle = () => act(async () => {});

describe("the related panel", () => {
  test("loading never says there are no related notes", async () => {
    const panel = mountPanel(() => new Promise<RelatedAnswer>(() => {}));
    await settle();
    expect(panel.find("related-loading")).not.toBeNull();
    expect(panel.find("related-empty")).toBeNull();
    expect(panel.text()).not.toMatch(/no linked or related notes/i);
    panel.unmount();
  });

  test("a complete empty answer, and only that, says so", async () => {
    const panel = mountPanel(async () => ({ relations: [], unresolved: [], possiblyIncomplete: false }));
    await settle();
    expect(panel.find("related-loading")).toBeNull();
    expect(panel.find("related-empty")).not.toBeNull();
    panel.unmount();
  });

  test("renders the two groups and the reasons in words", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    const linked = panel.find("related-group-linked")!;
    const related = panel.find("related-group-related")!;
    expect(linked.textContent).toContain("back");
    expect(linked.textContent).toContain("links here");
    expect(linked.textContent).not.toContain("plan-b");
    for (const words of ["linked from here", "cites the same note", "cites the same URL", "related text", "nearby"]) {
      expect(related.textContent).toContain(words);
    }
    expect(related.textContent).not.toContain("back");
    for (const raw of ["links_here", "linked_from_here", "shares_target", "shares_url", "related_text"]) {
      expect(panel.text()).not.toContain(raw);
    }
    panel.unmount();
  });

  test("evidence is plain text, never markup", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    expect(panel.container.querySelector("script")).toBeNull();
    expect(panel.text()).toContain("<script>alert(1)</script>");
    panel.unmount();
  });

  test("the incomplete state shows its notice and no empty sentence", async () => {
    const panel = mountPanel(async () => ({ relations: [], unresolved: [], possiblyIncomplete: true }));
    await settle();
    expect(panel.find("related-incomplete")).not.toBeNull();
    expect(panel.find("related-empty")).toBeNull();
    panel.unmount();
  });

  test("a row tap opens that note's path", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    const row = panel.container.querySelector<HTMLElement>('[aria-label="Open 1-projects/plan-b.md"]')!;
    expect(row).not.toBeNull();
    act(() => row.click());
    expect(panel.onOpen).toHaveBeenCalledWith("1-projects/plan-b.md");
    panel.unmount();
  });

  test("unresolved links show their states in words, and no workspace count", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    const list = panel.find("related-unresolved")!;
    const rows = [...list.querySelectorAll('[data-testid="related-unresolved-row"]')].map((row) => row.textContent);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("gone.md");
    expect(rows[0]).toContain("missing");
    expect(rows[1]).toContain("ambiguous");
    expect(rows[2]).toContain("not supported");
    expect(rows[3]).toContain("not a valid link");
    expect(rows[4]).toContain("not yet checked");
    expect(list.textContent).not.toMatch(/\d+ (problems?|broken)/i);
    panel.unmount();
  });

  test("offline: asks nothing and says it needs a connection", async () => {
    const relatedNotes = jest.fn<Related>(async () => ANSWER);
    const panel = mountPanel(relatedNotes, "offline");
    await settle();
    expect(relatedNotes).not.toHaveBeenCalled();
    expect(panel.find("related-offline")!.textContent).toMatch(/connection/i);
    expect(panel.find("related-empty")).toBeNull();
    panel.unmount();
  });

  test("a failed call is unavailable, not empty, and can be retried", async () => {
    let fail = true;
    const relatedNotes = jest.fn<Related>(async () => {
      if (fail) throw new Error("FILE_NOT_FOUND");
      return ANSWER;
    });
    const panel = mountPanel(relatedNotes);
    await settle();
    expect(panel.find("related-unavailable")).not.toBeNull();
    expect(panel.find("related-empty")).toBeNull();
    fail = false;
    act(() => panel.container.querySelector<HTMLElement>('[data-testid="related-retry"]')!.click());
    await settle();
    expect(panel.find("related-group-linked")).not.toBeNull();
    panel.unmount();
  });

  test("absent on a browser with no relatedNotes (the demo console)", async () => {
    const panel = mountPanel(undefined);
    await settle();
    expect(panel.find("related-panel")).toBeNull();
    expect(panel.text()).toBe("");
    panel.unmount();
  });
});

/* -------------------------------------------------------------------------- */

describe("reachability: under a note in the mounted console", () => {
  for (const [layout, width] of [["phone", 390], ["pointer", 1200]] as const) {
    test(`on the ${layout} layout, and a row opens the note`, async () => {
      const select = jest.fn();
      const relatedNotes = jest.fn<Related>(async () => ANSWER);
      const app = mountConsole(dataWith({ relatedNotes, select } as never), width);
      await settle();
      expect(relatedNotes).toHaveBeenCalledWith(NOTE);
      expect(app.find("related-panel")).not.toBeNull();
      app.press(app.find2("Open 1-projects/back.md"));
      expect(select).toHaveBeenCalledWith("1-projects/back.md");
    });
  }

  test("not drawn when the browser has no relatedNotes", async () => {
    const app = mountConsole(dataWith(), 1200);
    await settle();
    expect(app.find("related-panel")).toBeNull();
  });
});
