# Search results (Phase 5): short record

Measured 2026-10-07 and 2026-10-08 on `link-graph/phase-5-retrieval`. This file replaces the 618 lines of experiment tables that came out of the benchmark harness. The harness and the code it measured were removed after the decision below. They live in git history at commit `7a31b985` (and its parents): re-run from there if anyone wants to check a number.

## What was measured

- **Settings.** BASELINE.md's: 20 ms per store operation and per D1 request, subrequest budget 600, Node on macOS, synthetic data only. Cost is subrequests per query (store operations, or D1 requests for Fast Search).
- **Sets.** Judged (seed 1, 41 queries), held-out (seed 2, 48 queries, frozen before tuning), links (24 synthetic queries over notes whose links decide the answer), hotpot (300 HotpotQA questions over 4,904 Wikipedia intros, only 17 percent of links kept). Sizes 100, 1,000 and 10,000 notes for judged and held-out; links at 1,000; hotpot at 4,904.
- **Arms.**

| Arm | What it is |
|---|---|
| B0 original | Bucket search as it was: tokenizer with a light suffix stripper, first 2,048 characters of a note. |
| chunking | B1 with the old tokenizer: notes indexed as 1,000-character chunks up to 64,000 characters. |
| tokenizer | B1 with the new tokenizer: Porter2, `Intl.Segmenter` words, CJK pieces, identifier splitting, accent folding. |
| anchors | B6: tokenizer plus link display text and source titles as a low-weight field. |
| graph boost | B2 to B4: anchors not included; neighbours of the top hits fused in by rank at query time. |
| PageRank | B7: a personalized PageRank walk from the top 10 hits, fused by score. |
| Fast Search | B5: the D1 projection. A product feature, unchanged and not part of this decision. |

## Headline numbers at 1,000 notes

Recall@10, then subrequests per query. "not run" means that arm was never measured on that set.

| Arm | links | held-out | hotpot (4,904) |
|---|---|---|---|
| B0 original | 0.59 / 8.33 | 0.66 / 6.54 | 0.86 / 28.00 |
| chunking | not run | 0.74 / 5.27 | not run |
| tokenizer | 0.59 / 8.38 | 0.92 / 4.17 | 0.86 / 28.00 |
| anchors | 0.76 / 8.67 | 0.92 / 4.17 | 0.90 / 28.00 |
| graph boost | 0.92 / 25.71 | 0.96 / 11.75 | 0.87 / 58.71 (old tokenizer) |
| PageRank | 0.92 / 35.50 | 0.96 / 11.92 | 0.92 / 167.40 |
| Fast Search | 0.59 / 2.00 | 0.60 / 2.00 | 0.00 / 2.00 |

Notes on the table. The tokenizer row on links and hotpot is B1 at 2,000-character chunks; chunk size (1,000, 2,000, 4,000) did not move quality or cost on any set. The hotpot graph boost row is the old-tokenizer arm, the only one run there. Bucket search chose the hotpot difficulty classes, so its own hotpot score is biased low; compare the other arms with each other. Fast Search scores 0.00 on hotpot because its match requires every query word on one page.

By class:

- **Tokenizer.** Held-out morph 0.56 to 1.00 and cjk 0.00 to 1.00 at 1,000 notes; at 10,000 notes morph 0.50 to 1.00, cjk 0.00 to 1.00, code 0.50 to 0.75. No class went down.
- **Anchors.** Links alias 0.00 to 1.00; cluster (0.30), url (0.50) and hub (0.75) unchanged. No regression on held-out or judged.
- **Graph boost and PageRank.** Links cluster 0.30 to 1.00 and hub 0.75 to 1.00; held-out `linked` 0.50 to 1.00; PageRank also reaches 0.92 recall on hotpot where anchors reach 0.90. Neither lifts the url class on links.

## The 10,000-note held-out row (solo run, the decision run)

| Arm | Recall@10 | nDCG@10 | Subrequests per query | Warm p95 ms | Rule met |
|---|---|---|---|---|---|
| B0 original | 0.63 | 0.62 | 12.02 | 840 | base |
| chunking (1,000) | 0.71 | 0.71 | 9.54 | 777 | yes |
| tokenizer (1,000) | 0.90 | 0.87 | 6.40 | 684 | yes |
| graph boost b2 (4,000-character chunks) | 0.94 | 0.91 | 14.73 | 1457 | no |

Anchors and PageRank were not run at 10,000 notes. The rule (ruling OPEN-66): recall and nDCG both strictly higher than the arm it builds on, no class lower by more than 0.05, exact and title at 1.00, warm p95 and subrequests per query no more than 10 percent higher, and no more shed or oversized shards. Graph boost lifted recall by 0.04 and cost 2.3 times the subrequests and more than twice the warm p95, so it failed the rule. B3 and B4 were identical to B2 on this corpus. Chunk size: all three sizes met the rule in the solo run, so the rule's smallest size, 1,000, was chosen. Index cost did not move with any switch at 10,000 notes (34 shards, nothing shed or oversized).

## What the graph arms cost

Against the anchors arm at 1,000 notes (the same lexical format), recall gained and requests multiplied:

| Arm | links | held-out | hotpot |
|---|---|---|---|
| graph boost | +0.16 for 3.0 times | +0.04 for 2.8 times | +0.01 for 2.1 times (against B0, old tokenizer) |
| PageRank | +0.16 for 4.1 times | +0.04 for 2.9 times | +0.02 for 6.0 times (against anchors) |

On hotpot every PageRank query passed the free tier's 50-subrequest ceiling and 24 of 300 walks hit the read cap and were withheld. The only large recall gain is on the synthetic links set, which was written by the same people who wrote the features: it shows the mechanisms work, not how much real workspaces gain. No measured set contains the case PageRank was built for (a full lexical list with several relevant notes that many seeds link to and that hold none of the query words); a unit test built that case, and no benchmark showed the gain.

## Decision

- **Shipped, always on, no switch:** the tokenizer, chunking (1,000-character target, 64,000-character cap per note) and anchor text. On held-out they cost fewer subrequests per query than B0 (4.17 against 6.54), and the anchors arm adds no query-time reads (8.67 against 8.33 on links).
- **Evaluated and removed:** query-time graph boost (variants b2, b3, b4) and PageRank. The 10,000-note rule failed and the cost was 2 to 6 times the requests for gains of 0.01 to 0.04 recall on the realistic sets, with a larger gain only on the synthetic links set. The link graph itself stays: related notes, link suggestions, move repair through the index and the console link panel use it.
- **Not decided here:** Fast Search stays as it is. The latency gate against Fast Search was never decidable without staging round trips (ruling OPEN-69).

## Limits

- No run used a real bucket, real R2 or S3, or a real workspace; latency columns are wall clock under shared CPU and are not comparable across runs.
- The links set is synthetic. Hotpot uses 2017 questions over current Wikipedia text with sparse links.
- Anchors and PageRank have no 10,000-note run, and chunking has no links or hotpot run.
- Wikipedia data for hotpot was fetched at bench time and never committed (CC BY-SA 4.0).

## Where the removed work lives

At commit `7a31b985` and its parents: `apps/mcp/bench/` (runner, engines, fixtures, HotpotQA and wikitext loaders, metrics), `pnpm --filter @context/mcp bench:search`, `apps/mcp/src/graph/ppr.js`, `apps/mcp/src/search/fuse.js`, the graph-boost wiring in `apps/mcp/src/graph/retrieve.js`, `route.js` and `wrangler.toml` (`SEARCH_GRAPH_BOOST`), and their tests. The synthetic corpus generator survives as `apps/mcp/test/fixtures/searchCorpus.js`.
