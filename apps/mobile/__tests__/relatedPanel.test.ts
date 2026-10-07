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
 * Fix round 1 (each a temporary edit; exactly the named test failed):
 *
 *   answer not keyed on the asker            "a workspace switch ..."
 *   no refresh on the note's version          "asks again when ... version"
 *   drawing / encrypted check removed        "does not ask about a drawing" / "... locked or encrypted note"
 *   row back to role="link"                  "a row is a native button ..."
 *   label of the path alone                  "a row's accessible name ..."
 *   aria-live removed, or heading level 3    "arrived results are announced ..."
 *   rows opened with files.select            "a row follows like a link ..."
 *   empty reasons, empty path or NaN accepted "rejects empty reasons ..."
 *   duplicates kept                          "drops a repeated path ..."
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

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dataWith, emptyEditor, ENTRY, FILE, mountConsole, NOTE } from "./noteChrome/fixtures";
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

  test("rejects empty reasons, empty paths and non-finite offsets", () => {
    const good = wire(ANSWER) as Record<string, unknown>;
    const bad: unknown[] = [
      { ...good, relations: [{ path: "a.md", reasons: [] }] },
      { ...good, relations: [{ path: "", reasons: ["nearby"] }] },
      { ...good, unresolved: [{ target: "x", start: Number.NaN, end: 1, state: "missing" }] },
      { ...good, unresolved: [{ target: "x", start: 0, end: Number.POSITIVE_INFINITY, state: "missing" }] },
    ];
    for (const raw of bad) expect(() => parseRelatedAnswer(raw)).toThrow();
  });

  test("drops a repeated path, keeping the first", () => {
    const parsed = parseRelatedAnswer({
      kind: "related",
      relations: [
        { path: "a.md", reasons: ["links_here"] },
        { path: "a.md", reasons: ["nearby"] },
        { path: "b.md", reasons: ["nearby"] },
      ],
      unresolved: [],
      possiblyIncomplete: false,
    });
    expect(parsed.relations).toEqual([
      { path: "a.md", reasons: ["links_here"] },
      { path: "b.md", reasons: ["nearby"] },
    ]);
  });
});

/* -------------------------------------------------------------------------- */

type Related = NonNullable<FileBrowser["relatedNotes"]>;

type PanelInputs = {
  reachability?: "online" | "offline";
  path?: string;
  editor?: { path: string | null; etag: string | null; encrypted: boolean };
};

function mountPanel(relatedNotes: Related | undefined, reachabilityOrInputs: "online" | "offline" | PanelInputs = "online") {
  const onOpen = jest.fn<(path: string) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (ask: Related | undefined, inputs: PanelInputs = {}) => {
    const path = inputs.path ?? NOTE;
    const files = {
      relatedNotes: ask,
      sync: { reachability: inputs.reachability ?? "online", counts: { pending: 0, failed: 0, conflicts: 0 }, durable: true },
      editor: inputs.editor ?? { path, etag: "e1", encrypted: false },
    } as unknown as FileBrowser;
    act(() => root.render(createElement(RelatedPanel, { files, path, onOpen })));
  };
  render(relatedNotes, typeof reachabilityOrInputs === "string" ? { reachability: reachabilityOrInputs } : reachabilityOrInputs);
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    container,
    find,
    onOpen,
    render,
    row: (path: string) => container.querySelector<HTMLElement>(`[aria-label^="Open ${path}"]`),
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
    const row = panel.row("1-projects/plan-b.md")!;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the related panel: which answer, when", () => {
  test("a workspace switch on the same path shows loading, never the old workspace's answer", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    expect(panel.text()).toContain("plan-b");
    const pending = deferred<RelatedAnswer>();
    const otherWorkspace = jest.fn<Related>(() => pending.promise);
    panel.render(otherWorkspace);
    await settle();
    expect(otherWorkspace).toHaveBeenCalledWith(NOTE);
    expect(panel.find("related-loading")).not.toBeNull();
    expect(panel.text()).not.toContain("plan-b");
    await act(async () => pending.resolve({ relations: [], unresolved: [], possiblyIncomplete: false }));
    expect(panel.find("related-empty")).not.toBeNull();
    panel.unmount();
  });

  test("a cold or deep-link open asks exactly once, when the editor holds the note", async () => {
    const ask = jest.fn<Related>(async () => ANSWER);
    // The URL named the note; the editor has not read anything yet.
    const panel = mountPanel(ask, { editor: { path: null, etag: null, encrypted: false } });
    await settle();
    expect(panel.find("related-loading")).not.toBeNull();
    // The editor took the path; the read has not landed, so no version yet.
    panel.render(ask, { editor: { path: NOTE, etag: null, encrypted: false } });
    await settle();
    panel.render(ask, { editor: { path: NOTE, etag: "e1", encrypted: false } });
    await settle();
    panel.render(ask, { editor: { path: NOTE, etag: "e1", encrypted: false } });
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(panel.text()).toContain("plan-b");
    panel.unmount();
  });

  test("a note not saved yet draws nothing, and the first save shows the panel at once", async () => {
    const ask = jest.fn<Related>(async () => ANSWER);
    const panel = mountPanel(ask, { editor: { path: NOTE, etag: null, encrypted: false } });
    await settle();
    expect(panel.find("related-panel")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    panel.render(ask, { editor: { path: NOTE, etag: "e1", encrypted: false } });
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(panel.text()).toContain("plan-b");
    panel.unmount();
  });

  test("a cold open of a locked note asks zero times", async () => {
    const ask = jest.fn<Related>(async () => ANSWER);
    const panel = mountPanel(ask, { editor: { path: null, etag: null, encrypted: false } });
    await settle();
    panel.render(ask, { editor: { path: NOTE, etag: null, encrypted: false } });
    await settle();
    panel.render(ask, { editor: { path: NOTE, etag: "e1", encrypted: true } });
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(panel.find("related-panel")).toBeNull();
    panel.unmount();
  });

  describe("after saves (fake timers)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });
    const at = (etag: string) => ({ editor: { path: NOTE, etag, encrypted: false } });

    test("asks again once the version has been stable for 2 s, keeping the answer meanwhile", async () => {
      const ask = jest.fn<Related>(async () => ANSWER);
      const panel = mountPanel(ask, at("e1"));
      await settle();
      expect(ask).toHaveBeenCalledTimes(1);
      panel.render(ask, at("e2"));
      await act(async () => jest.advanceTimersByTime(1999));
      expect(ask).toHaveBeenCalledTimes(1);
      expect(panel.text()).toContain("plan-b");
      await act(async () => jest.advanceTimersByTime(1));
      expect(ask).toHaveBeenCalledTimes(2);
      panel.unmount();
    });

    test("a burst of 4 autosaves within 2 s costs one request", async () => {
      const ask = jest.fn<Related>(async () => ANSWER);
      const panel = mountPanel(ask, at("e1"));
      await settle();
      for (const etag of ["e2", "e3", "e4", "e5"]) {
        panel.render(ask, at(etag));
        await act(async () => jest.advanceTimersByTime(500));
      }
      expect(ask).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(2000));
      expect(ask).toHaveBeenCalledTimes(2);
      await act(async () => jest.advanceTimersByTime(10_000));
      expect(ask).toHaveBeenCalledTimes(2);
      panel.unmount();
    });

    test("a path switch during the wait cancels the refresh", async () => {
      const ask = jest.fn<Related>(async () => ANSWER);
      const panel = mountPanel(ask, at("e1"));
      await settle();
      panel.render(ask, at("e2"));
      await act(async () => jest.advanceTimersByTime(1000));
      const other = "1-projects/other.md";
      panel.render(ask, { path: other, editor: { path: other, etag: "o1", encrypted: false } });
      await act(async () => jest.advanceTimersByTime(5000));
      expect(ask.mock.calls).toEqual([[NOTE], [other]]);
      panel.unmount();
    });
  });

  test("does not ask about a drawing", async () => {
    const ask = jest.fn<Related>(async () => ANSWER);
    const drawing = "1-projects/plan.excalidraw.md";
    const panel = mountPanel(ask, { path: drawing, editor: { path: drawing, etag: "e1", encrypted: false } });
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(panel.find("related-panel")).toBeNull();
    panel.unmount();
  });

  test("does not ask about a locked or encrypted note", async () => {
    const ask = jest.fn<Related>(async () => ANSWER);
    const panel = mountPanel(ask, { editor: { path: NOTE, etag: "e1", encrypted: true } });
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(panel.find("related-panel")).toBeNull();
    panel.unmount();
  });
});

describe("the related panel: keyboard and assistive technology", () => {
  test("a row is a native button, which Enter and Space activate in the browser", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    const row = panel.row("1-projects/plan-b.md")!;
    /*
      react-native-web draws `role="button"` as a real <button>, and a browser
      turns Enter and Space on one into a click (the reviewer's Chrome and
      WebKit probe: a div[role=link] got no click from Enter, a <button> did).
      jsdom does not synthesize that click, so what is asserted is the element
      and the click it routes.
    */
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    act(() => row.click());
    expect(panel.onOpen).toHaveBeenCalledWith("1-projects/plan-b.md");
    panel.unmount();
  });

  test("a row's accessible name carries its path, reasons and evidence", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    const label = panel.row("3-resources/web.md")!.getAttribute("aria-label")!;
    for (const part of ["3-resources/web.md", "cites the same URL", "related text", "nearby", "<script>alert(1)</script>"]) {
      expect(label).toContain(part);
    }
    expect(panel.row("1-projects/back.md")!.getAttribute("aria-label")).toContain("links here");
    panel.unmount();
  });

  test("arrived results are announced, under a level 2 heading with level 3 groups", async () => {
    const panel = mountPanel(async () => ANSWER);
    await settle();
    expect(panel.find("related-panel")!.getAttribute("aria-live")).toBe("polite");
    const headings = [...panel.container.querySelectorAll('[role="heading"]')].map((node) => [
      node.getAttribute("aria-level"),
      node.textContent,
    ]);
    expect(headings[0]).toEqual(["2", "Linked and related notes"]);
    for (const [level] of headings.slice(1)) expect(level).toBe("3");
    expect(headings.length).toBeGreaterThan(1);
    panel.unmount();
  });
});

/* -------------------------------------------------------------------------- */

// The note read and on screen: the panel asks only once the editor holds a version of it.
const readEditor = { ...emptyEditor, status: "clean", path: NOTE, baseline: FILE, draft: FILE, etag: "e1" };

describe("reachability: under a note in the mounted console", () => {
  for (const [layout, width] of [["phone", 390], ["pointer", 1200]] as const) {
    test(`on the ${layout} layout, and a row opens the note`, async () => {
      const select = jest.fn();
      const relatedNotes = jest.fn<Related>(async () => ANSWER);
      const app = mountConsole(dataWith({ relatedNotes, select, editor: readEditor } as never), width);
      await settle();
      expect(relatedNotes).toHaveBeenCalledWith(NOTE);
      expect(app.find("related-panel")).not.toBeNull();
      app.press(app.container.querySelector<HTMLElement>('[aria-label^="Open 1-projects/back.md"]'));
      expect(select).toHaveBeenCalledWith("1-projects/back.md");
    });
  }

  test("a row follows like a link: the note opens in a pinned tab beside this one", async () => {
    const select = jest.fn(() => true);
    // `back.md` listed beside the note, or the tab strip's prune would close its tab as a deleted note.
    const listings = {
      "1-projects": {
        path: "1-projects",
        folderDefault: "team" as const,
        truncated: false,
        manifestUsable: true,
        entries: [ENTRY, { ...ENTRY, path: "1-projects/back.md", name: "back.md" }],
      },
    };
    const app = mountConsole(dataWith({ relatedNotes: async () => ANSWER, select, listings, editor: readEditor } as never), 1200);
    await settle();
    app.press(app.container.querySelector<HTMLElement>('[aria-label^="Open 1-projects/back.md"]'));
    expect(select).toHaveBeenCalledWith("1-projects/back.md");
    expect(app.find("tab-1-projects/back.md")).not.toBeNull();
  });

  test("not drawn when the browser has no relatedNotes", async () => {
    const app = mountConsole(dataWith(), 1200);
    await settle();
    expect(app.find("related-panel")).toBeNull();
  });
});
