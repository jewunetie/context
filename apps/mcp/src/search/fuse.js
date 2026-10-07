// Rank fusion for graph-assisted search (Task 29, OPEN-67, README 12.3).
// Pure: lists in, one order out. Ranks are fused, never raw scores, so a BM25
// score is never compared with a graph weight.

/**
 * `lexical` is the ranked lexical key list; `graphLists` are independently
 * ranked candidate lists (each already visible-only). The first `pinned`
 * lexical keys keep their places (an exact lexical hit is never buried);
 * everything else, the rest of the lexical list included, is ordered by
 * reciprocal rank fusion: 1 / (k + rank) per lexical rank, `weight` /
 * (k + rank) per graph list it appears in (first rank only), ties by key.
 * A lexical key needs no graph support to stay in the answer.
 */
export function fuseRanks(lexical, graphLists, { pinned, k, weight }) {
  const head = lexical.slice(0, pinned);
  const fixed = new Set(head);
  const score = new Map();
  const add = (key, s) => {
    if (!fixed.has(key)) score.set(key, (score.get(key) ?? 0) + s);
  };
  lexical.forEach((key, i) => add(key, 1 / (k + i + 1)));
  for (const list of graphLists) [...new Set(list)].forEach((key, i) => add(key, weight / (k + i + 1)));
  const tail = [...score].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).map(([key]) => key);
  return [...head, ...tail];
}
