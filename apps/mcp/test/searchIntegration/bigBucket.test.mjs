/**
 * (c)/(h) a bucket too large to index in one pass: the backfill that spends
 * its budget across searches. See
 * searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  BIG_TOKEN,
  PRIVACY_MANIFEST,
  PRIVACY_MANIFEST_READ,
  SEARCH_RESULT_LIMIT,
  SEARCH_SUBREQUEST_BUDGET,
  SUBREQUEST_LIMIT,
  searchText,
} from "./fixtures.mjs";

export async function runSearchIntegrationBigBucketChecks(check, harness) {
  const { big, env } = harness;

    // -- (c)/(h) a bucket too large to index in one pass ---------------------
    big.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 65; n += 1) {
      big.seed(
        `1-projects/bulk/note-${String(n).padStart(3, "0")}.md`,
        `# Bulk note ${n}\n\nEvery bulk note mentions the widget, this one is number ${n}.\n`
      );
    }

    big.resetCounts();
    const bigFirst = await searchText(env, BIG_TOKEN, { query: "widget" });
    const bigFirstOps = big.ops;
    check(
      "one search on a 65-note context stays inside the subrequest budget",
      bigFirstOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        bigFirstOps < SUBREQUEST_LIMIT
    );
    check(
      "and it answers rather than failing on the notes it did reach",
      typeof bigFirst === "string" && bigFirst.includes("1-projects/bulk/note-")
    );

    // The floor language belongs to the *indexed* answer, and the first search
    // over a bucket with no index is the literal scan — which has its own
    // honest sentence and a different one. What the deferred pass built by then
    // is what the second search reads, and it is genuinely partial: 65 notes do
    // not fit in one invocation's budget.
    big.resetCounts();
    const bigSecond = await searchText(env, BIG_TOKEN, { query: "widget" });
    check(
      "a backfill that ran out of budget says so, in the floor language the census uses",
      bigSecond.includes("still catching up")
    );
    check(
      "and the floor carries no count, which would be a fact about notes the caller may not see",
      !/still catching up[^\]]*\d/.test(bigSecond)
    );
    check(
      "the second search on that context is bounded too, and continues the backfill",
      // Every write is behind the response now, and which ones they are is the
      // point: a shard the backfill landed in, the manifest over it, and the
      // diff under it. A pass that wrote only the manifest would be vouching
      // for docs no shard holds.
      big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET && big.counts.put >= 2
    );
    check(
      "results stay bounded at the result limit however many notes match",
      (bigSecond.match(/^1-projects\/bulk\//gm) || []).length <= SEARCH_RESULT_LIMIT
    );

}
