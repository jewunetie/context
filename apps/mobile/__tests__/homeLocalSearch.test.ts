/**
 * The homepage's search, over the notes held in the tab.
 *
 * Before this the homepage's browser rejected every search ("This console
 * cannot search"), so a visitor typing three letters got "That search could not
 * be run" under a list of file names. Its notes are all in memory, so it
 * answers the way a workspace's index does: the note by its title, and the
 * line that matched.
 */

import { describe, expect, test } from "@jest/globals";
import { termsOf } from "../../mcp/src/search/text.js";
import { DEFAULT_TOKENIZER, localTerms, searchLocalNotes, snippetFor } from "../features/home/localSearch";

const NOTES = {
  "01-context.md": "---\ntitle: wth is this\n---\n# wth is this\n\ncontext is a notes app for you, your team, claude.\n",
  "02-pricing.md": "# Pricing\n\nfree, you cheapo\n",
  "03-devlog.md":
    "# devlog\n\n- shipped onboarding, **private** sharing and a [new tree](/tree) for everyone who asked for one\n",
  "Legal/drawing.excalidraw.md": "# Excalidraw Data\n\nprivate pricing\n",
};

describe("searchLocalNotes", () => {
  test("a title match comes before a body match, and each hit is named by its title", () => {
    const answer = searchLocalNotes(NOTES, "pri");
    expect(answer.hits.map((hit) => [hit.path, hit.title])).toEqual([
      ["02-pricing.md", "Pricing"],
      ["03-devlog.md", "devlog"],
    ]);
  });

  test("a body match carries the words around it, without the Markdown", () => {
    const [hit] = searchLocalNotes(NOTES, "private").hits;
    expect(hit?.snippets).toEqual(["shipped onboarding, private sharing and a new tree for everyone…"]);
  });

  test("the heading that is the title is not quoted back as the snippet", () => {
    const [hit] = searchLocalNotes(NOTES, "wth").hits;
    expect(hit?.path).toBe("01-context.md");
    expect(hit?.snippets).toEqual([]);
  });

  test("a drawing's data is not searched as words", () => {
    expect(searchLocalNotes(NOTES, "excalidraw").hits).toEqual([]);
  });

  test("the answer is complete, and says so", () => {
    const answer = searchLocalNotes(NOTES, "nothing like this");
    expect(answer).toEqual({
      hits: [],
      indexMissing: false,
      indexIncomplete: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    });
  });

  test("an empty query finds nothing rather than everything", () => {
    expect(searchLocalNotes(NOTES, "   ").hits).toEqual([]);
  });
});

describe("snippetFor", () => {
  test("cuts a long line to a window around the match", () => {
    const line = `${"a".repeat(100)} needle ${"b".repeat(100)}`;
    const snippet = snippetFor(line, "needle", "Title")!;
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThan(90);
  });
});

/*
 * Parity with the gateway (Task 34, OPEN-62). The app tokenizes with the
 * gateway's own `termsOf`, so "indexer, query parser and local search switch
 * tokenizer together" holds by construction; these tests pin it.
 *
 * Sabotage record (each guard broken once, named test confirmed red, restored):
 *  - `DEFAULT_TOKENIZER` set to 2: "the app default is tokenizer 1", "app terms
 *    equal the gateway's terms" and the `private` snippet case failed.
 *  - `localTerms` pinned to tokenizer 1: "app terms equal the gateway's terms"
 *    failed, and so did the Chinese, identifier and snippet tokenizer 2 searches.
 *  - matching on the whole query string instead of its terms: the
 *    tokenizer 2 stem, identifier and snippet tests failed.
 *  There is no second copy of the rules to drift (the app imports `termsOf`),
 *  so "one rule changed in one copy" is the second sabotage.
 */
const FIXTURES = [
  "Pricing for the private plan",
  "fetchUserProfile and get_user_profile.v2",
  "We deployed the stories and classes yesterday",
  "数据库迁移计划已经确认",
  "Café résumé naïve",
  "it\u2019s the owner\u2019s note",
  "",
];

describe("parity with the gateway tokenizer", () => {
  test("the app default is tokenizer 1", () => {
    expect(DEFAULT_TOKENIZER).toBe(1);
  });

  test("app terms equal the gateway's terms, term for term, for tokenizers 1 and 2", () => {
    for (const version of [1, 2]) {
      for (const text of FIXTURES) expect(localTerms(text, version)).toEqual(termsOf(text, version));
    }
    for (const text of FIXTURES) expect(localTerms(text)).toEqual(termsOf(text, 1));
  });
});

describe("searchLocalNotes with the default tokenizer", () => {
  test("a prefix of a word finds it, and an infix no longer does", () => {
    expect(searchLocalNotes(NOTES, "pri").hits.map((h) => h.path)).toEqual(["02-pricing.md", "03-devlog.md"]);
    expect(searchLocalNotes(NOTES, "ate").hits).toEqual([]);
  });
});

describe("searchLocalNotes with tokenizer 2", () => {
  const notes = {
    "plan.md": "# Plan\n\n数据库迁移计划已经确认\n",
    "ship.md": "# Ship\n\nwe deployed on friday\n",
    "code.md": "# Code\n\ncall fetchUserProfile first\n",
  };
  const paths = (query: string) => searchLocalNotes(notes, query, 20, 2).hits.map((h) => h.path);

  test("a Chinese word inside a run finds the note", () => {
    expect(paths("迁移")).toEqual(["plan.md"]);
  });
  test("a stem finds an inflection", () => {
    expect(paths("deploying")).toEqual(["ship.md"]);
  });
  test("the words of an identifier find the identifier", () => {
    expect(paths("user profile")).toEqual(["code.md"]);
  });
  test("the snippet is the line that matched", () => {
    const [hit] = searchLocalNotes(notes, "user profile", 20, 2).hits;
    expect(hit?.snippets).toEqual(["call fetchUserProfile first"]);
  });
});
