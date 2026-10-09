/**
 * `seedQuery` builds the one loose query related notes and link suggestions
 * run from a note's own text. It hands the query parser the words as written,
 * so a camelCase identifier is split the way the indexer split it, and it
 * deduplicates on the tokenizer's terms.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   words lowercased before they reach the query                            2
 *   deduplicated on the raw spelling, not on the tokenizer's terms           1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { queryTermsOf } from "../src/search/text.js";
import { seedQuery } from "../src/graph/retrieve.js";

test("a camelCase identifier reaches the parser whole, so it splits as the indexer split it", () => {
  const query = seedQuery({ path: "notes/a.md", body: "# Profiles\n\nCall fetchUserProfile before rendering.\n" }, "related_notes");
  assert.ok(query.includes("fetchUserProfile"), query);
  const terms = queryTermsOf(query);
  for (const term of ["fetchuserprofile", "fetch", "user"]) assert.ok(terms.includes(term), `${term} in ${terms.join(" ")}`);
});

test("words that share a stem are one query term, the title first", () => {
  const query = seedQuery({ path: "notes/a.md", body: "# Running\n\nShe runs and runs, then goes running again.\n" }, "related_notes");
  assert.equal(queryTermsOf(query).filter((term) => term === "run").length, 1, query);
  assert.equal(query.split(" ")[0], "Running");
});
