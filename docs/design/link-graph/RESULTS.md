# Search results (Phase 5)

Measured 2026-10-07 on `link-graph/phase-5-retrieval` at 3f99ff73 (Task 38). BASELINE.md stays the preregistered Phase 0 record (ruling OPEN-70). Settings are BASELINE's: 20 ms per store operation and per D1 request, subrequest budget 600, Node on macOS. Held-out set is seed 2 (ruling OPEN-64), 48 queries; judged set is seed 1, 41 queries.

Every table below came from this command, with `<size>` and `<set>` as its heading says:

```sh
pnpm --filter @context/mcp bench:search -- --sizes <size> --set <set> --latency 20 --budget 600 \
  --engines B0,B5,B1:c1000,B1,B1:c4000,B1:tok2:c1000,B1:tok2,B1:tok2:c4000,B2,B3,B4,B2:tok2,B3:tok2,B4:tok2 \
  | grep -v '^{"event"'
```

The six matrix runs (two sets, three sizes) ran concurrently on one machine, so their latency columns carry CPU contention. The decision table (held-out, 10,000 notes) was rerun alone with this command, and the decision uses that run:

```sh
pnpm --filter @context/mcp bench:search -- --sizes 10000 --set heldout --latency 20 --budget 600 \
  --engines B0,B5,B1:c1000,B1,B1:c4000,B1:tok2:c1000,B1:tok2,B1:tok2:c4000,B2:tok2:c4000,B3:tok2:c4000,B4:tok2:c4000 \
  | grep -v '^{"event"'
```

Arm names: `B1 tok1 c2000` is the v3 format with tokenizer 1 and 2,000-character chunks; `B2/B3/B4 ... b2/b3/b4` add graph-assisted ranking on that lexical arm. Quality columns are deterministic; a rerun of any 1,000-note arm reproduces them.

## Decision (ruling OPEN-66, held-out set, 10,000 notes, solo run)

| Arm | Builds on | Recall@10 | nDCG@10 | Worst class change | exact / title | Warm p95 vs base | Subrequests vs base | Shed / oversized | Rule met |
|---|---|---|---|---|---|---|---|---|---|
| B1 tok1 c1000 | B0 | 0.71 vs 0.63 | 0.71 vs 0.62 | none lower | 1.00 / 1.00 | 777 vs 840 (-7%) | 9.54 vs 12.02 (-21%) | 0 / 0 vs 0 / 0 | yes |
| B1 tok1 c2000 | B0 | 0.71 vs 0.63 | 0.71 vs 0.62 | none lower | 1.00 / 1.00 | 756 vs 840 (-10%) | 9.54 vs 12.02 | 0 / 0 | yes |
| B1 tok1 c4000 | B0 | 0.71 vs 0.63 | 0.71 vs 0.62 | none lower | 1.00 / 1.00 | 862 vs 840 (+3%) | 9.54 vs 12.02 | 0 / 0 | yes |
| B1 tok2 c1000 | B1 tok1 c1000 | 0.90 vs 0.71 | 0.87 vs 0.71 | none lower | 1.00 / 1.00 | 684 vs 777 (-12%) | 6.40 vs 9.54 (-33%) | 0 / 0 | yes |
| B2 tok2 c4000 b2 | B1 tok2 | 0.94 vs 0.90 | 0.91 vs 0.87 | none lower | 1.00 / 1.00 | 1457 vs 684 (+113%) | 14.73 vs 6.40 (+130%) | 0 / 0 | no |
| B3 tok2 c4000 b3 | B1 tok2 | 0.94 vs 0.90 | 0.91 vs 0.87 | none lower | 1.00 / 1.00 | 1493 vs 684 | 14.73 vs 6.40 | 0 / 0 | no |
| B4 tok2 c4000 b4 | B1 tok2 | 0.94 vs 0.90 | 0.91 vs 0.87 | none lower | 1.00 / 1.00 | 1433 vs 684 | 14.73 vs 6.40 | 0 / 0 | no |

- **Chunk size.** Quality and subrequests are identical at 1,000, 2,000 and 4,000 on both sets and all sizes; all three meet the rule in the solo run, so the rule's "smallest size meeting it" picks **1,000**. In the concurrent run 1,000 and 2,000 missed the latency clause (+29% and +11.5% warm p95) and 4,000 met it: the latency clause flips between runs with no quality difference behind it, which is the noise the ruling's cost note predicts (p95 of 48 queries is one of the top three samples). The choice between chunk sizes is therefore made by the tie-break in practice; a reviewer who prefers P8's 2,000 loses nothing measurable.
- **Tokenizer 2** meets the rule against tokenizer 1 at every chunk size: morph 0.50 to 1.00, cjk 0.00 to 1.00, code 0.50 to 0.75, nothing lower, and fewer subrequests.
- **Graph value (B2 versus B1, DELIVERY 17.3).** B2 lifts only the `linked` class (0.50 to 1.00) and nothing else; Recall@10 +0.04, nDCG@10 +0.04. It costs 2.3 times the subrequests (6.40 to 14.73 mean, max 57, 3 of 48 queries over the free tier's 50) and doubles warm p95. B3 and B4 are identical to B2 on this corpus (the fixtures have no shared URLs or folder structure that changes rankings). Rule not met; graph boost stays off. On the judged set (no `linked` class) graph arms add nothing and cost the same.
- **Index costs** do not move with any switch at 10,000 notes: 34 shards, 0 shed, 0 oversized, index bytes within 2.3%. Every v3 arm reports 2 partial notes (the two `deep` notes past 64,000 characters, as Task 36 predicted), which is why `deep` is 0.67, and takes 37 build passes against B0's 19 (one v3 write per pass during the build).

## P3 table (judged set, seed 1, 10,000 notes, concurrent run)

| Arm | Recall@10 (at least 0.66) | nDCG@10 (at least 0.66) | Subrequests per query | Warm p95 ms |
|---|---|---|---|---|
| B0 bucket search | 0.60 (no) | 0.62 (no) | 14.46 | 797 |
| B5 Fast Search | 0.66 | 0.66 | 2.00 | 27 |
| B1 tok1 c1000 | 0.70 | 0.71 | 11.51 | 957 |
| B1 tok2 c1000 | 0.89 | 0.90 | 6.68 | 641 |
| B2 tok2 c2000 b2 | 0.89 | 0.90 | 14.59 | 1427 |

B1 tok2 passes both quality gates; platform cost is 3.3 times B5's subrequests per query (a different resource: R2 operations against D1 requests). **The latency gate is not decidable** (ruling OPEN-69): it needs staging R2 and D1 round trips, which were not measured. Under the 20 ms assumption B1 tok2's warm p95 is about 24 times B5's against a 1.5 times gate.

Not measured: staging latencies, real-provider runs, the agent-task arms of DELIVERY 17.1. BASELINE.md's Intl.Segmenter paragraph is unchanged: Task 35's staging check has not been run in this window.

## Full tables

### heldout-10000 (solo, decision run)


#### 10,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.63 | 0.62 | 0.71 | 117 / 861 / 960 | 107 / 840 / 968 | 12.02 |
| B5 Fast Search | 0.60 | 0.61 | 0.65 | 21 / 26 / 35 | 22 / 24 / 26 | 2.00 |
| B1 tok1 c1000 | 0.71 | 0.71 | 0.79 | 117 / 760 / 980 | 105 / 777 / 867 | 9.54 |
| B1 tok1 c2000 | 0.71 | 0.71 | 0.79 | 108 / 741 / 840 | 106 / 756 / 854 | 9.54 |
| B1 tok1 c4000 | 0.71 | 0.71 | 0.79 | 111 / 762 / 871 | 109 / 862 / 929 | 9.54 |
| B1 tok2 c1000 | 0.90 | 0.87 | 0.90 | 104 / 652 / 858 | 102 / 684 / 852 | 6.40 |
| B1 tok2 c2000 | 0.90 | 0.87 | 0.90 | 104 / 695 / 862 | 104 / 795 / 867 | 6.40 |
| B1 tok2 c4000 | 0.90 | 0.87 | 0.90 | 102 / 688 / 855 | 101 / 684 / 908 | 6.40 |
| B2 tok2 c4000 b2 | 0.94 | 0.91 | 0.90 | 311 / 1461 / 1634 | 322 / 1457 / 1965 | 14.73 |
| B3 tok2 c4000 b3 | 0.94 | 0.91 | 0.90 | 312 / 1524 / 1720 | 310 / 1493 / 1707 | 14.73 |
| B4 tok2 c4000 b4 | 0.94 | 0.91 | 0.90 | 306 / 1511 / 1706 | 299 / 1433 / 1721 | 14.73 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok2 c4000 b2 | B3 tok2 c4000 b3 | B4 tok2 c4000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.50 | 0.00 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| code | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.75 | 0.75 | 0.75 | 0.75 | 0.75 | 0.75 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| linked | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 |
| crosschunk | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 19 | - | 34 | 24,399,555 | 0 | 0 | 0 | 9997 | 828 / 845 / 2048 | 12.02 / 37 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 37 | - | 34 | 24,954,936 | 0 | 0 | 2 | 10205 | 828 / 845 / 1043 | 9.54 / 37 | 0 | 0 | - |
| B1 tok1 c2000 | 37 | - | 34 | 24,922,464 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 9.54 / 37 | 0 | 0 | - |
| B1 tok1 c4000 | 37 | - | 34 | 24,894,583 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 9.54 / 37 | 0 | 0 | - |
| B1 tok2 c1000 | 37 | - | 34 | 24,956,652 | 0 | 0 | 2 | 10205 | 828 / 845 / 1043 | 6.40 / 37 | 0 | 0 | - |
| B1 tok2 c2000 | 37 | - | 34 | 24,924,180 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 6.40 / 37 | 0 | 0 | - |
| B1 tok2 c4000 | 37 | - | 34 | 24,896,299 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 6.40 / 37 | 0 | 0 | - |
| B2 tok2 c4000 b2 | 37 | 141 | 34 | 24,896,299 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 14.73 / 57 | 3 | 0 | 0 |
| B3 tok2 c4000 b3 | 37 | 141 | 34 | 24,896,299 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 14.73 / 57 | 3 | 0 | 0 |
| B4 tok2 c4000 b4 | 37 | 141 | 34 | 24,896,299 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 14.73 / 57 | 3 | 0 | 0 |

B0 index built in 19 passes. 48 judged queries.

Script census, 10000 fixture notes: 10000 files; Latin 10000, Han 4, Hiragana 2, Katakana 1

### heldout-100


#### 100 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.65 | 0.73 | 90 / 201 / 206 | 82 / 196 / 212 | 5.15 |
| B5 Fast Search | 0.60 | 0.61 | 0.65 | 21 / 22 / 23 | 21 / 22 / 23 | 2.00 |
| B1 tok1 c1000 | 0.74 | 0.73 | 0.81 | 89 / 234 / 246 | 88 / 232 / 234 | 4.29 |
| B1 tok1 c2000 | 0.74 | 0.73 | 0.81 | 88 / 242 / 417 | 92 / 231 / 244 | 4.29 |
| B1 tok1 c4000 | 0.74 | 0.73 | 0.81 | 93 / 403 / 584 | 97 / 252 / 296 | 4.29 |
| B1 tok2 c1000 | 0.92 | 0.89 | 0.92 | 88 / 101 / 191 | 91 / 183 / 187 | 3.50 |
| B1 tok2 c2000 | 0.92 | 0.89 | 0.92 | 90 / 175 / 248 | 147 / 403 / 524 | 3.50 |
| B1 tok2 c4000 | 0.92 | 0.89 | 0.92 | 117 / 235 / 293 | 109 / 273 / 405 | 3.50 |
| B2 tok1 c2000 b2 | 0.78 | 0.77 | 0.81 | 252 / 405 / 507 | 252 / 378 / 378 | 10.81 |
| B3 tok1 c2000 b3 | 0.78 | 0.77 | 0.81 | 255 / 704 / 782 | 282 / 419 / 446 | 10.81 |
| B4 tok1 c2000 b4 | 0.78 | 0.77 | 0.81 | 237 / 504 / 686 | 262 / 463 / 532 | 10.81 |
| B2 tok2 c2000 b2 | 0.96 | 0.93 | 0.92 | 285 / 370 / 522 | 236 / 371 / 429 | 11.08 |
| B3 tok2 c2000 b3 | 0.96 | 0.93 | 0.92 | 246 / 413 / 506 | 239 / 367 / 368 | 11.08 |
| B4 tok2 c2000 b4 | 0.96 | 0.93 | 0.92 | 245 / 371 / 378 | 256 / 385 / 427 | 11.08 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.56 | 0.00 | 0.56 | 0.56 | 0.56 | 1.00 | 1.00 | 1.00 | 0.56 | 0.56 | 0.56 | 1.00 | 1.00 | 1.00 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.75 | 0.50 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| linked | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| crosschunk | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 1 | - | 1 | 507,150 | 0 | 0 | 0 | 97 | 827 / 2048 / 2048 | 5.15 / 11 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 1 | - | 1 | 929,647 | 0 | 0 | 2 | 305 | 825 / 850 / 1043 | 4.29 / 12 | 0 | 0 | - |
| B1 tok1 c2000 | 1 | - | 1 | 897,175 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 4.29 / 12 | 0 | 0 | - |
| B1 tok1 c4000 | 1 | - | 1 | 869,294 | 0 | 0 | 2 | 138 | 846 / 3694 / 3718 | 4.29 / 12 | 0 | 0 | - |
| B1 tok2 c1000 | 1 | - | 1 | 931,279 | 0 | 0 | 2 | 305 | 825 / 850 / 1043 | 3.50 / 5 | 0 | 0 | - |
| B1 tok2 c2000 | 1 | - | 1 | 898,807 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 3.50 / 5 | 0 | 0 | - |
| B1 tok2 c4000 | 1 | - | 1 | 870,926 | 0 | 0 | 2 | 138 | 846 / 3694 / 3718 | 3.50 / 5 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 1 | 2 | 1 | 897,175 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 10.81 / 17 | 0 | 0 | 0 |
| B3 tok1 c2000 b3 | 1 | 2 | 1 | 897,175 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 10.81 / 17 | 0 | 0 | 0 |
| B4 tok1 c2000 b4 | 1 | 2 | 1 | 897,175 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 10.81 / 17 | 0 | 0 | 0 |
| B2 tok2 c2000 b2 | 1 | 2 | 1 | 898,807 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 11.08 / 17 | 0 | 0 | 0 |
| B3 tok2 c2000 b3 | 1 | 2 | 1 | 898,807 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 11.08 / 17 | 0 | 0 | 0 |
| B4 tok2 c2000 b4 | 1 | 2 | 1 | 898,807 | 0 | 0 | 2 | 199 | 1627 / 1650 / 2004 | 11.08 / 17 | 0 | 0 | 0 |

B0 index built in 1 passes. 48 judged queries.

Script census, 100 fixture notes: 100 files; Latin 100, Han 4, Hiragana 2, Katakana 1

### heldout-1000


#### 1,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.65 | 0.73 | 110 / 301 / 310 | 84 / 290 / 305 | 6.54 |
| B5 Fast Search | 0.60 | 0.61 | 0.65 | 21 / 23 / 24 | 21 / 25 / 34 | 2.00 |
| B1 tok1 c1000 | 0.74 | 0.73 | 0.81 | 90 / 313 / 342 | 96 / 318 / 342 | 5.27 |
| B1 tok1 c2000 | 0.74 | 0.73 | 0.81 | 117 / 471 / 576 | 94 / 355 / 508 | 5.27 |
| B1 tok1 c4000 | 0.74 | 0.73 | 0.81 | 89 / 321 / 372 | 90 / 359 / 638 | 5.27 |
| B1 tok2 c1000 | 0.92 | 0.89 | 0.92 | 139 / 551 / 653 | 146 / 448 / 708 | 4.17 |
| B1 tok2 c2000 | 0.92 | 0.89 | 0.92 | 103 / 224 / 306 | 87 / 213 / 453 | 4.17 |
| B1 tok2 c4000 | 0.92 | 0.89 | 0.92 | 115 / 255 / 420 | 89 / 159 / 165 | 4.17 |
| B2 tok1 c2000 b2 | 0.78 | 0.77 | 0.81 | 293 / 776 / 998 | 254 / 553 / 752 | 11.90 |
| B3 tok1 c2000 b3 | 0.78 | 0.77 | 0.81 | 277 / 534 / 901 | 271 / 535 / 570 | 11.90 |
| B4 tok1 c2000 b4 | 0.78 | 0.77 | 0.81 | 283 / 429 / 536 | 234 / 425 / 765 | 11.90 |
| B2 tok2 c2000 b2 | 0.96 | 0.93 | 0.92 | 252 / 428 / 498 | 238 / 427 / 440 | 11.75 |
| B3 tok2 c2000 b3 | 0.96 | 0.93 | 0.92 | 256 / 442 / 527 | 247 / 449 / 486 | 11.75 |
| B4 tok2 c2000 b4 | 0.96 | 0.93 | 0.92 | 253 / 434 / 474 | 238 / 426 / 428 | 11.75 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.56 | 0.00 | 0.56 | 0.56 | 0.56 | 1.00 | 1.00 | 1.00 | 0.56 | 0.56 | 0.56 | 1.00 | 1.00 | 1.00 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.75 | 0.50 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| linked | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| crosschunk | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 3 | - | 4 | 2,680,800 | 0 | 0 | 0 | 997 | 826 / 846 / 2048 | 6.54 / 15 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 5 | - | 4 | 3,114,964 | 0 | 0 | 2 | 1205 | 826 / 844 / 1043 | 5.27 / 16 | 0 | 0 | - |
| B1 tok1 c2000 | 5 | - | 4 | 3,082,492 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 5.27 / 16 | 0 | 0 | - |
| B1 tok1 c4000 | 5 | - | 4 | 3,054,611 | 0 | 0 | 2 | 1038 | 827 / 1040 / 3718 | 5.27 / 16 | 0 | 0 | - |
| B1 tok2 c1000 | 5 | - | 4 | 3,116,705 | 0 | 0 | 2 | 1205 | 826 / 844 / 1043 | 4.17 / 7 | 0 | 0 | - |
| B1 tok2 c2000 | 5 | - | 4 | 3,084,233 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 4.17 / 7 | 0 | 0 | - |
| B1 tok2 c4000 | 5 | - | 4 | 3,056,352 | 0 | 0 | 2 | 1038 | 827 / 1040 / 3718 | 4.17 / 7 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 5 | 13 | 4 | 3,082,492 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.90 / 19 | 0 | 0 | 0 |
| B3 tok1 c2000 b3 | 5 | 13 | 4 | 3,082,492 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.90 / 19 | 0 | 0 | 0 |
| B4 tok1 c2000 b4 | 5 | 13 | 4 | 3,082,492 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.90 / 19 | 0 | 0 | 0 |
| B2 tok2 c2000 b2 | 5 | 13 | 4 | 3,084,233 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.75 / 19 | 0 | 0 | 0 |
| B3 tok2 c2000 b3 | 5 | 13 | 4 | 3,084,233 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.75 / 19 | 0 | 0 | 0 |
| B4 tok2 c2000 b4 | 5 | 13 | 4 | 3,084,233 | 0 | 0 | 2 | 1099 | 827 / 1640 / 2004 | 11.75 / 19 | 0 | 0 | 0 |

B0 index built in 3 passes. 48 judged queries.

Script census, 1000 fixture notes: 1000 files; Latin 1000, Han 4, Hiragana 2, Katakana 1

### heldout-10000


#### 10,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.63 | 0.62 | 0.71 | 106 / 762 / 784 | 106 / 766 / 995 | 12.02 |
| B5 Fast Search | 0.60 | 0.61 | 0.65 | 21 / 22 / 22 | 21 / 23 / 23 | 2.00 |
| B1 tok1 c1000 | 0.71 | 0.71 | 0.79 | 155 / 1122 / 1489 | 99 / 987 / 1076 | 9.54 |
| B1 tok1 c2000 | 0.71 | 0.71 | 0.79 | 142 / 900 / 1373 | 139 / 854 / 1369 | 9.54 |
| B1 tok1 c4000 | 0.71 | 0.71 | 0.79 | 101 / 878 / 1547 | 91 / 777 / 1082 | 9.54 |
| B1 tok2 c1000 | 0.90 | 0.87 | 0.90 | 126 / 651 / 949 | 98 / 636 / 780 | 6.40 |
| B1 tok2 c2000 | 0.90 | 0.87 | 0.90 | 102 / 633 / 780 | 105 / 643 / 836 | 6.40 |
| B1 tok2 c4000 | 0.90 | 0.87 | 0.90 | 101 / 635 / 770 | 99 / 630 / 883 | 6.40 |
| B2 tok1 c2000 b2 | 0.75 | 0.74 | 0.79 | 264 / 1453 / 1706 | 263 / 1509 / 1570 | 18.83 |
| B3 tok1 c2000 b3 | 0.75 | 0.74 | 0.79 | 269 / 1376 / 1405 | 268 / 1396 / 1818 | 18.83 |
| B4 tok1 c2000 b4 | 0.75 | 0.74 | 0.79 | 267 / 1391 / 1453 | 261 / 1393 / 1817 | 18.83 |
| B2 tok2 c2000 b2 | 0.94 | 0.91 | 0.90 | 270 / 1260 / 1419 | 284 / 1269 / 1405 | 14.73 |
| B3 tok2 c2000 b3 | 0.94 | 0.91 | 0.90 | 263 / 1312 / 1431 | 264 / 1244 / 1429 | 14.73 |
| B4 tok2 c2000 b4 | 0.94 | 0.91 | 0.90 | 295 / 1274 / 1418 | 315 / 1499 / 1630 | 14.73 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.50 | 0.00 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.75 | 0.75 | 0.75 | 0.50 | 0.50 | 0.50 | 0.75 | 0.75 | 0.75 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| linked | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| crosschunk | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 19 | - | 34 | 24,399,555 | 0 | 0 | 0 | 9997 | 828 / 845 / 2048 | 12.02 / 37 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 37 | - | 34 | 24,954,936 | 0 | 0 | 2 | 10205 | 828 / 845 / 1043 | 9.54 / 37 | 0 | 0 | - |
| B1 tok1 c2000 | 37 | - | 34 | 24,922,464 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 9.54 / 37 | 0 | 0 | - |
| B1 tok1 c4000 | 37 | - | 34 | 24,894,583 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 9.54 / 37 | 0 | 0 | - |
| B1 tok2 c1000 | 37 | - | 34 | 24,956,652 | 0 | 0 | 2 | 10205 | 828 / 845 / 1043 | 6.40 / 37 | 0 | 0 | - |
| B1 tok2 c2000 | 37 | - | 34 | 24,924,180 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 6.40 / 37 | 0 | 0 | - |
| B1 tok2 c4000 | 37 | - | 34 | 24,896,299 | 0 | 0 | 2 | 10038 | 828 / 846 / 3718 | 6.40 / 37 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 37 | 141 | 34 | 24,922,464 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 18.83 / 57 | 8 | 0 | 0 |
| B3 tok1 c2000 b3 | 37 | 141 | 34 | 24,922,464 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 18.83 / 57 | 8 | 0 | 0 |
| B4 tok1 c2000 b4 | 37 | 141 | 34 | 24,922,464 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 18.83 / 57 | 8 | 0 | 0 |
| B2 tok2 c2000 b2 | 37 | 141 | 34 | 24,924,180 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 14.73 / 57 | 3 | 0 | 0 |
| B3 tok2 c2000 b3 | 37 | 141 | 34 | 24,924,180 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 14.73 / 57 | 3 | 0 | 0 |
| B4 tok2 c2000 b4 | 37 | 141 | 34 | 24,924,180 | 0 | 0 | 2 | 10099 | 828 / 846 / 2004 | 14.73 / 57 | 3 | 0 | 0 |

B0 index built in 19 passes. 48 judged queries.

Script census, 10000 fixture notes: 10000 files; Latin 10000, Han 4, Hiragana 2, Katakana 1

### judged-100


#### 100 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.68 | 0.73 | 92 / 199 / 370 | 82 / 198 / 204 | 5.39 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 21 / 22 / 25 | 21 / 22 / 23 | 2.00 |
| B1 tok1 c1000 | 0.76 | 0.77 | 0.83 | 88 / 225 / 236 | 89 / 229 / 236 | 4.39 |
| B1 tok1 c2000 | 0.76 | 0.77 | 0.83 | 88 / 229 / 329 | 89 / 229 / 286 | 4.39 |
| B1 tok1 c4000 | 0.76 | 0.77 | 0.83 | 91 / 232 / 241 | 94 / 426 / 535 | 4.39 |
| B1 tok2 c1000 | 0.89 | 0.90 | 0.93 | 93 / 185 / 307 | 89 / 186 / 232 | 3.56 |
| B1 tok2 c2000 | 0.89 | 0.90 | 0.93 | 88 / 96 / 236 | 88 / 166 / 242 | 3.56 |
| B1 tok2 c4000 | 0.89 | 0.90 | 0.93 | 118 / 171 / 229 | 144 / 450 / 657 | 3.56 |
| B2 tok1 c2000 b2 | 0.76 | 0.77 | 0.83 | 293 / 557 / 670 | 248 / 378 / 432 | 10.54 |
| B3 tok1 c2000 b3 | 0.76 | 0.77 | 0.83 | 243 / 427 / 444 | 291 / 514 / 732 | 10.54 |
| B4 tok1 c2000 b4 | 0.76 | 0.77 | 0.83 | 238 / 454 / 537 | 234 / 513 / 540 | 10.54 |
| B2 tok2 c2000 b2 | 0.89 | 0.90 | 0.93 | 292 / 454 / 494 | 252 / 383 / 503 | 10.44 |
| B3 tok2 c2000 b3 | 0.89 | 0.90 | 0.93 | 260 / 370 / 475 | 233 / 365 / 368 | 10.44 |
| B4 tok2 c2000 b4 | 0.89 | 0.90 | 0.93 | 231 / 364 / 367 | 238 / 376 / 478 | 10.44 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.63 | 0.00 | 0.63 | 0.63 | 0.63 | 0.69 | 0.69 | 0.69 | 0.63 | 0.63 | 0.63 | 0.69 | 0.69 | 0.69 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.75 | 0.50 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 1 | - | 1 | 501,398 | 0 | 0 | 0 | 97 | 828 / 2048 / 2048 | 5.39 / 11 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 1 | - | 1 | 880,860 | 0 | 0 | 2 | 281 | 825 / 850 / 1035 | 4.39 / 12 | 0 | 0 | - |
| B1 tok1 c2000 | 1 | - | 1 | 852,304 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 4.39 / 12 | 0 | 0 | - |
| B1 tok1 c4000 | 1 | - | 1 | 829,108 | 0 | 0 | 2 | 135 | 845 / 3694 / 3708 | 4.39 / 12 | 0 | 0 | - |
| B1 tok2 c1000 | 1 | - | 1 | 882,772 | 0 | 0 | 2 | 281 | 825 / 850 / 1035 | 3.56 / 12 | 0 | 0 | - |
| B1 tok2 c2000 | 1 | - | 1 | 854,216 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 3.56 / 12 | 0 | 0 | - |
| B1 tok2 c4000 | 1 | - | 1 | 831,020 | 0 | 0 | 2 | 135 | 845 / 3694 / 3708 | 3.56 / 12 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 1 | 2 | 1 | 852,304 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.54 / 17 | 0 | 0 | 0 |
| B3 tok1 c2000 b3 | 1 | 2 | 1 | 852,304 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.54 / 17 | 0 | 0 | 0 |
| B4 tok1 c2000 b4 | 1 | 2 | 1 | 852,304 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.54 / 17 | 0 | 0 | 0 |
| B2 tok2 c2000 b2 | 1 | 2 | 1 | 854,216 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.44 / 17 | 0 | 0 | 0 |
| B3 tok2 c2000 b3 | 1 | 2 | 1 | 854,216 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.44 / 17 | 0 | 0 | 0 |
| B4 tok2 c2000 b4 | 1 | 2 | 1 | 854,216 | 0 | 0 | 2 | 187 | 1035 / 1650 / 2008 | 10.44 / 17 | 0 | 0 | 0 |

B0 index built in 1 passes. 41 judged queries.

Script census, 100 fixture notes: 100 files; Latin 100, Han 4, Hiragana 2, Katakana 2

### judged-1000


#### 1,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.66 | 0.68 | 0.73 | 117 / 320 / 365 | 105 / 311 / 346 | 6.98 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 21 / 22 / 23 | 21 / 21 / 22 | 2.00 |
| B1 tok1 c1000 | 0.76 | 0.77 | 0.83 | 87 / 307 / 339 | 88 / 371 / 451 | 5.56 |
| B1 tok1 c2000 | 0.76 | 0.77 | 0.83 | 91 / 317 / 364 | 116 / 643 / 717 | 5.56 |
| B1 tok1 c4000 | 0.76 | 0.77 | 0.83 | 91 / 319 / 474 | 88 / 333 / 608 | 5.56 |
| B1 tok2 c1000 | 0.89 | 0.90 | 0.93 | 97 / 179 / 605 | 168 / 601 / 736 | 4.20 |
| B1 tok2 c2000 | 0.89 | 0.90 | 0.93 | 125 / 550 / 737 | 109 / 345 / 415 | 4.20 |
| B1 tok2 c4000 | 0.89 | 0.90 | 0.93 | 92 / 150 / 323 | 100 / 177 / 304 | 4.20 |
| B2 tok1 c2000 b2 | 0.76 | 0.77 | 0.83 | 295 / 440 / 489 | 316 / 928 / 1331 | 11.83 |
| B3 tok1 c2000 b3 | 0.76 | 0.77 | 0.83 | 296 / 597 / 609 | 237 / 677 / 1010 | 11.83 |
| B4 tok1 c2000 b4 | 0.76 | 0.77 | 0.83 | 323 / 507 / 520 | 256 / 511 / 573 | 11.83 |
| B2 tok2 c2000 b2 | 0.89 | 0.90 | 0.93 | 234 / 423 / 537 | 250 / 426 / 449 | 11.10 |
| B3 tok2 c2000 b3 | 0.89 | 0.90 | 0.93 | 236 / 422 / 428 | 233 / 421 / 572 | 11.10 |
| B4 tok2 c2000 b4 | 0.89 | 0.90 | 0.93 | 236 / 425 / 447 | 236 / 437 / 655 | 11.10 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.63 | 0.00 | 0.63 | 0.63 | 0.63 | 0.69 | 0.69 | 0.69 | 0.63 | 0.63 | 0.63 | 0.69 | 0.69 | 0.69 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.75 | 0.50 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 | 0.75 | 0.75 | 0.75 | 1.00 | 1.00 | 1.00 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 3 | - | 4 | 2,674,389 | 0 | 0 | 0 | 997 | 827 / 847 / 2048 | 6.98 / 15 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 5 | - | 4 | 3,065,162 | 0 | 0 | 2 | 1181 | 826 / 845 / 1035 | 5.56 / 16 | 0 | 0 | - |
| B1 tok1 c2000 | 5 | - | 4 | 3,036,606 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 5.56 / 16 | 0 | 0 | - |
| B1 tok1 c4000 | 5 | - | 4 | 3,013,410 | 0 | 0 | 2 | 1035 | 827 / 856 / 3708 | 5.56 / 16 | 0 | 0 | - |
| B1 tok2 c1000 | 5 | - | 4 | 3,067,143 | 0 | 0 | 2 | 1181 | 826 / 845 / 1035 | 4.20 / 16 | 0 | 0 | - |
| B1 tok2 c2000 | 5 | - | 4 | 3,038,587 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 4.20 / 16 | 0 | 0 | - |
| B1 tok2 c4000 | 5 | - | 4 | 3,015,391 | 0 | 0 | 2 | 1035 | 827 / 856 / 3708 | 4.20 / 16 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 5 | 13 | 4 | 3,036,606 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.83 / 19 | 0 | 0 | 0 |
| B3 tok1 c2000 b3 | 5 | 13 | 4 | 3,036,606 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.83 / 19 | 0 | 0 | 0 |
| B4 tok1 c2000 b4 | 5 | 13 | 4 | 3,036,606 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.83 / 19 | 0 | 0 | 0 |
| B2 tok2 c2000 b2 | 5 | 13 | 4 | 3,038,587 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.10 / 19 | 0 | 0 | 0 |
| B3 tok2 c2000 b3 | 5 | 13 | 4 | 3,038,587 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.10 / 19 | 0 | 0 | 0 |
| B4 tok2 c2000 b4 | 5 | 13 | 4 | 3,038,587 | 0 | 0 | 2 | 1087 | 828 / 1638 / 2008 | 11.10 / 19 | 0 | 0 | 0 |

B0 index built in 3 passes. 41 judged queries.

Script census, 1000 fixture notes: 1000 files; Latin 1000, Han 4, Hiragana 2, Katakana 2

### judged-10000


#### 10,000 notes

| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |
|---|---|---|---|---|---|---|
| B0 bucket search | 0.60 | 0.62 | 0.68 | 148 / 801 / 838 | 132 / 797 / 1059 | 14.46 |
| B5 Fast Search | 0.66 | 0.66 | 0.66 | 21 / 23 / 24 | 24 / 27 / 31 | 2.00 |
| B1 tok1 c1000 | 0.70 | 0.71 | 0.78 | 201 / 1387 / 2132 | 123 / 957 / 1094 | 11.51 |
| B1 tok1 c2000 | 0.70 | 0.71 | 0.78 | 132 / 1149 / 2656 | 126 / 972 / 1451 | 11.51 |
| B1 tok1 c4000 | 0.70 | 0.71 | 0.78 | 125 / 880 / 1140 | 156 / 816 / 1307 | 11.51 |
| B1 tok2 c1000 | 0.89 | 0.90 | 0.93 | 112 / 649 / 1115 | 102 / 641 / 810 | 6.68 |
| B1 tok2 c2000 | 0.89 | 0.90 | 0.93 | 101 / 632 / 821 | 110 / 640 / 896 | 6.68 |
| B1 tok2 c4000 | 0.89 | 0.90 | 0.93 | 102 / 635 / 808 | 103 / 629 / 814 | 6.68 |
| B2 tok1 c2000 b2 | 0.70 | 0.71 | 0.78 | 281 / 1534 / 1626 | 271 / 1400 / 1598 | 21.17 |
| B3 tok1 c2000 b3 | 0.70 | 0.71 | 0.78 | 268 / 1471 / 1529 | 280 / 1479 / 1902 | 21.17 |
| B4 tok1 c2000 b4 | 0.70 | 0.71 | 0.78 | 276 / 1403 / 1464 | 279 / 1424 / 1546 | 21.17 |
| B2 tok2 c2000 b2 | 0.89 | 0.90 | 0.93 | 267 / 1245 / 1427 | 273 / 1427 / 1590 | 14.59 |
| B3 tok2 c2000 b3 | 0.89 | 0.90 | 0.93 | 266 / 1270 / 1589 | 267 / 1327 / 1501 | 14.59 |
| B4 tok2 c2000 b4 | 0.89 | 0.90 | 0.93 | 264 / 1270 / 1438 | 270 / 1273 / 1560 | 14.59 |

Recall@10 by query class:

| Class | B0 bucket search | B5 Fast Search | B1 tok1 c1000 | B1 tok1 c2000 | B1 tok1 c4000 | B1 tok2 c1000 | B1 tok2 c2000 | B1 tok2 c4000 | B2 tok1 c2000 b2 | B3 tok1 c2000 b3 | B4 tok1 c2000 b4 | B2 tok2 c2000 b2 | B3 tok2 c2000 b3 | B4 tok2 c2000 b4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| exact | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| title | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| deep | 0.00 | 1.00 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 |
| multi | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| morph | 0.44 | 0.00 | 0.44 | 0.44 | 0.44 | 0.69 | 0.69 | 0.69 | 0.44 | 0.44 | 0.44 | 0.69 | 0.69 | 0.69 |
| cjk | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 |
| code | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 1.00 |
| message | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |

Index costs per arm:

| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 bucket search | 19 | - | 34 | 24,393,800 | 0 | 0 | 0 | 9997 | 828 / 845 / 2048 | 14.46 / 37 | 0 | 0 | - |
| B5 Fast Search | - | - | - | - | - | - | - | - | - | 2.00 / 2 | 0 | 0 | - |
| B1 tok1 c1000 | 37 | - | 34 | 24,905,818 | 0 | 0 | 2 | 10181 | 828 / 844 / 1035 | 11.51 / 38 | 0 | 0 | - |
| B1 tok1 c2000 | 37 | - | 34 | 24,877,262 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 11.51 / 38 | 0 | 0 | - |
| B1 tok1 c4000 | 37 | - | 34 | 24,854,066 | 0 | 0 | 2 | 10035 | 828 / 845 / 3708 | 11.51 / 38 | 0 | 0 | - |
| B1 tok2 c1000 | 37 | - | 34 | 24,907,791 | 0 | 0 | 2 | 10181 | 828 / 844 / 1035 | 6.68 / 39 | 0 | 0 | - |
| B1 tok2 c2000 | 37 | - | 34 | 24,879,235 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 6.68 / 39 | 0 | 0 | - |
| B1 tok2 c4000 | 37 | - | 34 | 24,856,039 | 0 | 0 | 2 | 10035 | 828 / 845 / 3708 | 6.68 / 39 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 37 | 141 | 34 | 24,877,262 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 21.17 / 58 | 9 | 0 | 0 |
| B3 tok1 c2000 b3 | 37 | 141 | 34 | 24,877,262 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 21.17 / 58 | 9 | 0 | 0 |
| B4 tok1 c2000 b4 | 37 | 141 | 34 | 24,877,262 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 21.17 / 58 | 9 | 0 | 0 |
| B2 tok2 c2000 b2 | 37 | 141 | 34 | 24,879,235 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 14.59 / 59 | 3 | 0 | 0 |
| B3 tok2 c2000 b3 | 37 | 141 | 34 | 24,879,235 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 14.59 / 59 | 3 | 0 | 0 |
| B4 tok2 c2000 b4 | 37 | 141 | 34 | 24,879,235 | 0 | 0 | 2 | 10087 | 828 / 845 / 2008 | 14.59 / 59 | 3 | 0 | 0 |

B0 index built in 19 passes. 41 judged queries.

Script census, 10000 fixture notes: 10000 files; Latin 10000, Han 4, Hiragana 2, Katakana 2


## Link-aware sets and anchor text (added after the Task 38 rule check)

These runs followed the Task 38 decision. They add two evaluation sets and two features: bare URLs as link occurrences (parser version 2) and anchor-text indexing (`SEARCH_ANCHOR_TEXT=1`, arm B6 = B1 tok2 c1000 plus anchors, parser version 3). Scripts: `bench/hotpot.mjs`, `bench/wikitext.js`, `generateLinks` in `bench/fixtures.js`. Wikipedia data is fetched at bench time into `~/.cache/context-bench` and never committed (CC BY-SA 4.0).

### The sets

- **links** (`--set links --sizes 1000`): 24 synthetic queries in six classes of four: cluster (10 linked notes, 3 hold the term), partial (30 one-word decoys), harm (10 lexical matches each linking 3 irrelevant notes), alias (`[[B|codename]]` queried by codename), url (two notes cite one URL, one holds the term), hub (a hub of 60 spokes linked from the relevant notes).
- **hotpot** (`--set hotpot`): 4,904 Wikipedia intro pages, 300 HotpotQA questions that are answerable but not already solved by plain search. Only 17 percent of links survive the slice (3.25 kept links per note), so link structure is sparse. Bucket search chose both the difficulty classes and the kept queries, so its own score on this set is biased low by construction. Compare the other arms with each other.

### Results

Recall@10 at 1,000 notes (hotpot at 4,904):

| Arm | links | held-out | hotpot | Subrequests per query (links / hotpot) |
|---|---|---|---|---|
| B0 bucket search | 0.59 | 0.66 | 0.86 | 8.33 / 28.00 |
| B1 tok2 c2000 | 0.59 | 0.92 | 0.86 | 8.38 / 28.00 |
| B6 tok2 c1000 plus anchors | 0.76 | 0.92 | 0.90 | 8.67 / 28.00 |
| B2 to B4 graph at query time (tok1) | 0.92 to 1.00 (1.00 for B3 with bare URLs) | 0.78 | 0.87 | 25.67 / 58.71 |
| B5 Fast Search | 0.59 | 0.60 | 0.00 | 2.00 / 2.00 |

By class on links: anchor text lifts alias from 0.00 to 1.00 and leaves cluster (0.30), url (0.50) and hub (0.75) unchanged. Graph arms lift cluster, alias and hub to 1.00, and B3 lifts url to 1.00 once bare URLs are link occurrences. No arm showed harm on the harm class.

On hotpot, B6 lifts the partial class from 0.78 to 0.84 and the hard class from 0.00 to 0.17. Graph arms add 0.01 recall at 2.1 times the subrequests, and 259 of 300 queries exceed the free-tier ceiling of 50.

Bucket search chose the hotpot classes, so the easy class is 1.00 for every arm except Fast Search by construction. Fast Search scores 0.00 on hotpot because its full-text match requires every query word to appear in one page, so whole-sentence questions match nothing. That is how it works today, not a harness defect.

### What this says

- Anchor text is the cheapest link signal measured: no query-time graph reads, no change in subrequests per query, one extra build pass, and gains on the two sets with real link structure. It does not replace the graph where relevant notes lack the query words and link only to each other (cluster) or through a hub.
- The query-time graph pays off only on densely linked corpora and costs 2 to 3 times the subrequests. On sparse real links it is not worth it. The Task 38 rule outcome stands: graph arms stay off by default.
- Held-out and judged sets show no regression from anchor text.

### Limits

- The links set is synthetic and written by the same people who wrote the features, so it favors them. It shows that the mechanisms work, not how much real workspaces gain.
- Hotpot uses 2017 questions over current Wikipedia text, with 17 percent of links kept.
- Latency columns are wall clock under shared CPU load and are not comparable across runs.
- No run used a real bucket, real R2 or S3, or a real workspace. The workspace census remains unrun.


## Personalized PageRank at query time (arm B7)

`SEARCH_GRAPH_BOOST=ppr` is a fourth graph variant beside b2, b3 and b4, off by default (`src/graph/ppr.js`, `src/graph/retrieve.js`). The top 10 lexical hits seed a random walk with restart (probability 0.15, 20 power iterations, weights 1 over lexical rank). The walk covers the notes within two links of the seeds, in both link directions, at most 60 notes. A link weighs 1 over the visible out-degree of the note it leaves, a note reached along several paths collects from each, and a note with more than 50 visible citers is a node but is not expanded. The fused order scores each note as 1 over its lexical rank plus 0.5 times its PageRank over the largest PageRank, so a note with no lexical match can reach the top 10. Raw BM25 scores are not exposed by search, so the lexical side is reciprocal rank. B7 is B6 (tok2 c1000 plus anchors) with this variant; the graph is built as for B2.

### Choosing the weight and the pins

Swept on the links set, then checked on held-out (1,000 notes, B7 only):

| Weight | Pinned | links recall / nDCG | links harm class recall | held-out recall / nDCG |
|---|---|---|---|---|
| 0.25 | 0 or 3 | 0.92 / 0.87 | 1.00 | 0.96 / 0.93 |
| 0.5 | 0 or 3 | 0.92 / 0.87 | 1.00 | 0.96 / 0.93 |
| 0.75 | 0 | 0.88 / 0.85 | 0.80 | not run |
| 1 | 0 | 0.87 / 0.84 | 0.70 | 0.96 / 0.93 |
| 1 | 3 | 0.87 / 0.84 | 0.70 | 0.96 / 0.93 |
| 2 | 0 | 0.87 / 0.83 | 0.70 | 0.96 / 0.93 |

Pinning the top 3 lexical hits changed nothing at a weight that does no harm, and did not prevent harm at a weight that does (the displaced exact matches sit at ranks 4 to 10). The shipped values are weight 0.5 and no pins. 0.5 is the largest weight measured without harm and 0.75 already costs the harm class 0.20, so the margin is small and the choice rests on one synthetic class.

### Results

Links set (24 queries, 1,000 notes). Cells in the class table are recall / nDCG / MRR. B2 is shown twice because the earlier B2 arm used tok1 c2000; the second row uses the same lexical format as B6 and B7.

| Arm | Recall@10 | nDCG@10 | MRR | Subrequests per query |
| --- | --- | --- | --- | --- |
| B1 tok2 c2000 | 0.59 | 0.65 | 0.83 | 8.38 |
| B6 tok2 c1000 anchors | 0.76 | 0.76 | 0.92 | 8.67 |
| B2 tok1 c2000 b2 | 0.92 | 0.87 | 0.92 | 25.67 |
| B2 tok2 c1000 b2 | 0.92 | 0.87 | 0.92 | 25.71 |
| B7 tok2 c1000 ppr anchors | 0.92 | 0.87 | 0.92 | 35.50 |

| Class | B1 tok2 c2000 | B6 tok2 c1000 anchors | B2 tok1 c2000 b2 | B2 tok2 c1000 b2 | B7 tok2 c1000 ppr anchors |
|---|---|---|---|---|---|
| cluster | 0.30 / 0.47 / 1.00 | 0.30 / 0.47 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| partial | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| harm | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| alias | 0.00 / 0.00 / 0.00 | 1.00 / 0.63 / 0.50 | 1.00 / 0.63 / 0.50 | 1.00 / 0.63 / 0.50 | 1.00 / 0.63 / 0.50 |
| url | 0.50 / 0.61 / 1.00 | 0.50 / 0.61 / 1.00 | 0.50 / 0.61 / 1.00 | 0.50 / 0.61 / 1.00 | 0.50 / 0.61 / 1.00 |
| hub | 0.75 / 0.83 / 1.00 | 0.75 / 0.83 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |

| Arm | Subrequests mean / max | Over 50 | Walks withheld | Graph-only in top 10 (total / relevant / queries) |
|---|---|---|---|---|
| B1 tok2 c2000 | 8.38 / 15 | 0 | - | - |
| B6 tok2 c1000 anchors | 8.67 / 15 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 25.67 / 45 | 0 | 0 | 40 / 36 / 12 |
| B2 tok2 c1000 b2 | 25.71 / 45 | 0 | 0 | 40 / 36 / 12 |
| B7 tok2 c1000 ppr anchors | 35.50 / 78 | 4 | 0 | 36 / 32 / 8 |

Held-out set (48 queries, 1,000 notes):

| Arm | Recall@10 | nDCG@10 | MRR | Subrequests per query |
| --- | --- | --- | --- | --- |
| B1 tok2 c2000 | 0.92 | 0.89 | 0.92 | 4.17 |
| B6 tok2 c1000 anchors | 0.92 | 0.89 | 0.92 | 4.17 |
| B2 tok1 c2000 b2 | 0.78 | 0.77 | 0.81 | 11.90 |
| B2 tok2 c1000 b2 | 0.96 | 0.93 | 0.92 | 11.75 |
| B7 tok2 c1000 ppr anchors | 0.96 | 0.93 | 0.92 | 11.92 |

| Class | B1 tok2 c2000 | B6 tok2 c1000 anchors | B2 tok1 c2000 b2 | B2 tok2 c1000 b2 | B7 tok2 c1000 ppr anchors |
|---|---|---|---|---|---|
| exact | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| title | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| deep | 0.67 / 0.67 / 0.67 | 0.67 / 0.67 / 0.67 | 0.67 / 0.67 / 0.67 | 0.67 / 0.67 / 0.67 | 0.67 / 0.67 / 0.67 |
| multi | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| morph | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 0.56 / 0.66 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| cjk | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 0.00 / 0.00 / 0.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| code | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 0.75 / 0.75 / 0.75 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| message | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| linked | 0.50 / 0.61 / 1.00 | 0.50 / 0.61 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 |
| crosschunk | 1.00 / 0.50 / 0.33 | 1.00 / 0.50 / 0.33 | 1.00 / 0.50 / 0.33 | 1.00 / 0.50 / 0.33 | 1.00 / 0.50 / 0.33 |

| Arm | Subrequests mean / max | Over 50 | Walks withheld | Graph-only in top 10 (total / relevant / queries) |
|---|---|---|---|---|
| B1 tok2 c2000 | 4.17 / 7 | 0 | - | - |
| B6 tok2 c1000 anchors | 4.17 / 7 | 0 | 0 | - |
| B2 tok1 c2000 b2 | 11.90 / 19 | 0 | 0 | 4 / 4 / 4 |
| B2 tok2 c1000 b2 | 11.75 / 19 | 0 | 0 | 4 / 4 / 4 |
| B7 tok2 c1000 ppr anchors | 11.92 / 19 | 0 | 0 | 4 / 4 / 4 |

The B2 tok1 row loses morph, cjk and code on held-out because of the tok1 tokenizer, not the graph: the tok2 row of B2 does not.

HotpotQA slice (300 queries, 4,904 notes; B6 and B7 only, run once for the tables and once more for MRR by class, with identical numbers):

| Arm | Recall@10 | nDCG@10 | MRR | Subrequests per query |
| --- | --- | --- | --- | --- |
| B6 tok2 c1000 anchors | 0.90 | 0.82 | 0.89 | 28.00 |
| B7 tok2 c1000 ppr anchors | 0.92 | 0.82 | 0.89 | 167.40 |

| Class | B6 tok2 c1000 anchors | B7 tok2 c1000 ppr anchors |
|---|---|---|
| easy | 1.00 / 0.94 / 0.94 | 1.00 / 0.93 / 0.94 |
| partial | 0.84 / 0.74 / 0.87 | 0.87 / 0.75 / 0.87 |
| hard | 0.17 / 0.10 / 0.06 | 0.17 / 0.11 / 0.08 |

| Arm | Subrequests mean / max | Over 50 | Walks withheld | Graph-only in top 10 (total / relevant / queries) |
|---|---|---|---|---|
| B6 tok2 c1000 anchors | 28.00 / 28 | 0 | 0 | - |
| B7 tok2 c1000 ppr anchors | 167.40 / 231 | 300 | 24 | 486 / 12 / 264 |

### What this says

- On the links and held-out sets, B7 reaches the same recall, nDCG and MRR as B2 at the same lexical format. It beats B6 on the cluster class (1.00 against 0.30 recall) and the hub class (1.00 against 0.75). It spends 35.5 subrequests per query on links against 25.7 for B2 and 8.7 for B6 (78 at most), and 4 of 24 queries pass 50. It cannot lift the url class: it does not walk shared URLs.
- On hotpot, B7 lifts recall from 0.90 to 0.92 over B6 (partial 0.84 to 0.87), with no change in nDCG or MRR. It costs 167 subrequests per query against 28 (231 at most), every query passes 50, and 24 of 300 walks hit the read cap and were withheld. Warm latency doubles under the bench's 20 ms store.
- 486 graph-only notes entered the top 10 on hotpot across 264 queries; 12 were judged relevant. The other 474 replaced lexical tail hits that were also mostly not relevant, which is why nDCG did not move. On links the counts are 36 graph-only, 32 relevant, 8 queries; B2 had 40, 36, 12. On held-out 4, 4, 4 for both.
- The one-hop boost (B2) added 0.01 recall over its lexical baseline on hotpot; PageRank added 0.02 over B6. Neither run controls for the other's lexical format on hotpot, so that comparison is indicative only.
- The benchmark sets do not contain the case PageRank is built for: a full lexical list with several relevant notes that many seeds link to and that hold none of the query words. `searchGraphPpr.test.mjs` builds that case (ten kestrel notes, four citing one note without the word) and ppr puts the note in the top 10 where b3 cannot. No measured set shows the gain.

### Limits

- Lexical fusion uses reciprocal rank, not raw scores. A score-based fusion needs scores returned from search, which would change search's output shape.
- The walk follows links only. Shared URLs (b3) and folder proximity (b4) are not edges; a shared target (b2) is reached as two hops through it.
- At the default search budget of 40 the walk never finishes and the answer is the lexical one, labelled. A deployment needs a budget of several hundred to use it.
- Weight tuning used one synthetic class. Treat 0.5 as provisional.
