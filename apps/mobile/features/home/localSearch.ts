import { isDrawingPath } from "@context/drawings";
import type { SearchAnswer } from "../console/files/browser";
import { noteHeading, splitNote } from "../console/files/frontmatter";
import { termsOf } from "../../../mcp/src/search/text.js";

/**
 * Search over the homepage's notes, which are all in the tab.
 *
 * The homepage is the console's own frame over notes held in memory
 * (`useLocalFileBrowser`), so the console's search answers there the way it
 * answers in a workspace: a hit is a note, named by its title, with the line
 * that matched. Nothing is asked of a server, because there is nothing behind
 * this page to ask — and the answer is complete, which is why it never says
 * the index is missing or behind.
 *
 * Titles first, then bodies, each in the tree's order: somebody typing
 * `pricing` means the page called Pricing before the page that mentions it.
 *
 * Matching is on the gateway's own tokenizer (`termsOf`), so the app, the
 * indexer and the query parser switch tokenizer together: a note matches when
 * every term of the query is a prefix of some term of its title or body.
 */

/**
 * The tokenizer version the app searches with. Stays 1 until the owner flips
 * the default (Task 39); the gateway's default is flipped in the same change.
 * lean: lives here because `search/text.js` has no shared constant yet; move
 * it there when the gateway switch (OPEN-57) lands.
 */
export const DEFAULT_TOKENIZER: 1 | 2 = 1;

/** The terms of `text`, from the gateway's tokenizer. */
export function localTerms(text: string, tokenizer: number = DEFAULT_TOKENIZER): string[] {
  return termsOf(text, tokenizer);
}

/** True when every query term is a prefix of some term in `terms`. */
function coversQuery(query: readonly string[], terms: readonly string[]): boolean {
  return query.every((q) => terms.some((t) => t.startsWith(q)));
}

/** Characters either side of the match a snippet keeps. */
const SNIPPET_REACH = 36;

const HEADING = /^#{1,6}\s+/;
/** List, quote and emphasis syntax, which is how the line is written rather than what it says. */
const LINE_SYNTAX = /^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)+/;
/** Comment anchors and other HTML comments: markers in the file, never words on the page. */
const COMMENTS = /<!--[\s\S]*?-->/g;

/** The words of one line, without the syntax that writes them. */
function plainLine(line: string): string {
  return line
    .replace(COMMENTS, "")
    .replace(HEADING, "")
    .replace(LINE_SYNTAX, "")
    .replace(/[*_`]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where in a lowercased line the first query word sits, or 0 when stemming hides it. */
function matchAt(lower: string, query: readonly string[]): number {
  const found = query.map((q) => lower.indexOf(q)).filter((at) => at !== -1);
  return found.length === 0 ? 0 : Math.min(...found);
}

/** A window around `at`, with an ellipsis where the line was cut. */
function windowOf(line: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_REACH);
  const end = Math.min(line.length, at + length + SNIPPET_REACH);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

type BodyLine = { line: string; terms: string[] };

/** The body's lines as words, without the title's own heading (the row already says it). */
function bodyLines(body: string, title: string, tokenizer: number): BodyLine[] {
  const lines: BodyLine[] = [];
  for (const raw of body.split("\n")) {
    const line = plainLine(raw);
    if (HEADING.test(raw.trim()) && line === title) continue;
    lines.push({ line, terms: localTerms(line, tokenizer) });
  }
  return lines;
}

/** The snippet of the first line whose terms cover the query, else the first line that has any of them. */
function snippetOf(lines: readonly BodyLine[], query: readonly string[], needle: string): string | null {
  const whole = lines.find((l) => coversQuery(query, l.terms));
  const hit = whole ?? lines.find((l) => query.some((q) => coversQuery([q], l.terms)));
  if (!hit) return null;
  const lower = hit.line.toLowerCase();
  const at = matchAt(lower, query);
  return windowOf(hit.line, at, query.find((q) => lower.startsWith(q, at))?.length ?? needle.length);
}

/**
 * The matching part of the first line whose terms match `needle`, trimmed to a
 * window around it with an ellipsis where it was cut. `null` for no match.
 */
export function snippetFor(
  body: string,
  needle: string,
  title: string,
  tokenizer: number = DEFAULT_TOKENIZER,
): string | null {
  const query = localTerms(needle, tokenizer);
  if (query.length === 0) return null;
  return snippetOf(bodyLines(body, title, tokenizer), query, needle);
}

export function searchLocalNotes(
  notes: Readonly<Record<string, string>>,
  query: string,
  limit = 20,
  tokenizer: number = DEFAULT_TOKENIZER,
): SearchAnswer {
  const terms = localTerms(query, tokenizer);
  const byTitle: SearchAnswer["hits"] = [];
  const byBody: SearchAnswer["hits"] = [];
  if (terms.length > 0) {
    for (const [path, text] of Object.entries(notes)) {
      // A drawing's body is the canvas's data, not words anybody wrote.
      if (isDrawingPath(path)) continue;
      const title = noteHeading(text, path);
      const lines = bodyLines(splitNote(text).body, title, tokenizer);
      const inBody = coversQuery(terms, lines.flatMap((l) => l.terms));
      const snippet = inBody ? snippetOf(lines, terms, query) : null;
      if (coversQuery(terms, localTerms(title, tokenizer))) {
        byTitle.push({ path, title, snippets: snippet === null ? [] : [snippet] });
      } else if (snippet !== null) {
        byBody.push({ path, title, snippets: [snippet] });
      }
    }
  }
  return {
    hits: [...byTitle, ...byBody].slice(0, limit),
    indexMissing: false,
    indexIncomplete: false,
    reducedRecall: false,
    reducedRecallNotes: [],
  };
}
