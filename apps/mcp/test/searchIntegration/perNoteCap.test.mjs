/**
 * The per-note index cap: the miss text that says a long note might be the reason. See
 * searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import { CHUNK } from "../../src/search/format.js";
import {
  DEEP_TOKEN,
  PRIVACY_MANIFEST,
  R2Store,
  converge,
  searchText,
} from "./fixtures.mjs";

export async function runSearchIntegrationPerNoteCapChecks(check, harness) {
  const { deep, env } = harness;

    // -- a miss says why it might be a miss, and truncation is one of the whys
    //
    // Indexing a note by its head is a new way for a search to be incomplete,
    // and the advice on a miss enumerated the others while leaving this one
    // out: "try the term the user would have typed, drop the prefix, call
    // orient". A term 5KB into a saved session answers to none of those, and
    // the agent concludes it is not written down — about a note it can read in
    // full. Deliberately no count and no per-query signal: which notes are
    // long is a fact about the whole bucket, private ones included.
    {
      deep.seed("privacy.md", PRIVACY_MANIFEST);
      deep.seed(
        "1-projects/session.md",
        `# Session\n\nopening prose\n${"filler words here ".repeat(600)}\nThe PLATYPUS is 10KB in.\n`
      );
      // Past the chunk cap (64,000 characters): the end of this note is not indexed.
      deep.seed(
        "1-projects/log.md",
        `# Log\n\nopening log\n${"filler words here ".repeat(4200)}\nThe WOMBAT is 75KB in.\n`
      );
      // Indexed first, deliberately. A search reads a ready index and there is
      // none here yet, and the bounded literal scan that answers instead reads
      // whole notes — so it *finds* a term the index cannot, which is the right
      // behaviour and the wrong fixture for a check about the index's own
      // recall limit.
      await converge(new R2Store(deep));
      const found = await searchText(env, DEEP_TOKEN, { query: "platypus" });
      check(
        "a term 10KB into a note is found, because a note is indexed in chunks up to 64,000 characters",
        found.includes("1-projects/session.md")
      );
      const missed = await searchText(env, DEEP_TOKEN, { query: "wombat" });
      check(
        "a term past the per-note cap misses, and the advice says a long note is indexed by its head",
        missed.includes("(no matches)") &&
          /indexed by (its|their) open/i.test(missed) &&
          // The number in the sentence is the constant, not a retyped copy of
          // it: prose saying 64,000 while the code says another is the "two
          // copies of a rule" failure with nothing running both.
          missed.includes(CHUNK.cap.toLocaleString("en-US"))
      );
      const hit = await searchText(env, DEEP_TOKEN, { query: "opening" });
      check(
        "and that sentence is on the miss, not appended to every answer",
        hit.includes("1-projects/session.md") && !/indexed by (its|their) open/i.test(hit)
      );
    }

}
