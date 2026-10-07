/**
 * The CJK fallback's own rung of the shard walk (CONTRACT-v3.md "Queries and
 * chunked results", ruling OPEN-48, Task 33 fix round 1).
 *
 * The walk routes and collects on the query's own terms. Only after it has
 * read, a tokenizer 2 query term containing CJK whose visible df is still 0
 * has its two-character pieces routed: the occupied shards whose filter may
 * hold every piece of that term (or has no filter) are read within the same
 * budget and reserve, like the expansion wave before it. A term that hit
 * directly never routes or collects its pieces, so a query that hits costs
 * what its words cost.
 *
 * A shard the first read already collected is read again for the pieces only,
 * with its doc count, lengths and expansion vocabulary zeroed, so `N`,
 * `avglen` and no term's df are counted twice. A shard read here for the first
 * time is collected in full, as the expansion wave does.
 */

import { readTermFilter, termFilterMayHold } from "./filter.js";
import { collectShardCandidates } from "./shardQuery.js";
import { decodeShard, fetchShardBytes } from "./shards.js";
import { cjkPieces } from "./text.js";

const NO_LEN = Object.freeze({ title: 0, headings: 0, tags: 0, body: 0 });

/**
 * Read the shards the fallback pieces route to and add their collections.
 *
 * @param {object} store
 * @param {{ remaining: number }} budget the search budget, shared with the walk
 * @param {number} limit the snippet reserve the walk keeps
 * @param {object} manifest the served manifest (`format.tokenizer`, `filters`)
 * @param {{ queryTerms: string[], occupied: number[], collections: object[],
 *   isVisible: (path: string) => boolean, shardsRead: number }} walk
 *   `collections` entries carry the shard `id` they were collected from; new
 *   collections are pushed onto it.
 * @returns {Promise<{ shardsUnread: boolean, shardsRead: number }>}
 *   `shardsUnread` when a shard it needed could not be read or afforded.
 */
export async function readFallbackPieceShards(store, budget, limit, manifest, walk) {
  const { queryTerms, occupied, collections, isVisible } = walk;
  let { shardsRead } = walk;
  if (manifest.format?.tokenizer !== 2) return { shardsUnread: false, shardsRead };

  const found = (term) => collections.some((c) => (Number(c.dfByTerm?.get(term)) || 0) > 0);
  const pieceSets = queryTerms
    .filter((term) => !found(term))
    .map((term) => cjkPieces(term).filter((piece) => piece !== term))
    .filter((pieces) => pieces.length > 0);
  if (pieceSets.length === 0) return { shardsUnread: false, shardsRead };
  // A piece that is also a query term was collected already; collecting it
  // again on a re-read shard would count its df twice.
  const pieces = [...new Set(pieceSets.flat())].filter((piece) => !queryTerms.includes(piece));

  const readIds = new Set(collections.map((c) => c.id));
  const claimed = occupied.filter((id) => {
    const filter = readTermFilter(manifest.filters[id]);
    return !filter || pieceSets.some((set) => set.every((piece) => termFilterMayHold(filter, piece)));
  });
  let shardsUnread = false;
  for (const id of claimed) {
    if (budget.remaining <= limit + 1) return { shardsUnread: true, shardsRead };
    const bytes = await fetchShardBytes(store, budget, limit, id, undefined, manifest);
    const shard = bytes && decodeShard(bytes);
    if (!shard) {
      shardsUnread = true;
      continue;
    }
    shardsRead += 1;
    if (readIds.has(id)) {
      collections.push({ ...collectShardCandidates(shard, pieces, isVisible), visibleN: 0, lenTotals: NO_LEN, vocab: new Map(), id });
    } else {
      collections.push({ ...collectShardCandidates(shard, [...queryTerms, ...pieces], isVisible), id });
    }
  }
  return { shardsUnread, shardsRead };
}
