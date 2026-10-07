# The search index, format v3: layout and dual reads

This extends [`CONTRACT.md`](./CONTRACT.md), whose v2 sections still describe
the index every workspace has today. Nothing here changes v2.

## The format object

`search/format.js`. A format is `{ tokenizer: 1 | 2, chunk: null | { target,
max, cap } }`. `DEFAULT_FORMAT = { tokenizer: 1, chunk: null }` is today's
index.

The switch is two deployment vars, unset in production (ruling OPEN-57):

| Var | Values | Anything else |
|---|---|---|
| `SEARCH_TOKENIZER` | `"1"`, `"2"` | tokenizer 1 |
| `SEARCH_CHUNK_CHARS` | `"0"` or absent (no chunking), `"1000"`, `"2000"`, `"4000"` | no chunking |

`indexFormatFor(env)` reads them and never throws. A chunked format carries
`max = 1.5 * target` (1,500, 3,000, 6,000; ruling OPEN-54) and `cap = 64,000`
characters per note. `formatUsable(format)` is true for the default and for any
format whose values are in range; Task 35 adds the `Intl.Segmenter` gate there.
The resolved format travels on the store as `store.searchIndexFormat` (Task
31), the way `searchSubrequestBudget` does.

## One namespace per format generation (ruling OPEN-56)

- `.context/search/v2/`: today's objects, exactly where and how they are
  (manifest version 3). Always the default format.
- `.context/search/v3/`: any non-default format.
  - `manifest.json`, **version 4**: every version 3 field, plus `format` (the
    object above), `shards` (one `{ key, digest }` per shard id, or `null` for
    nothing stored; Task 31 fills it) and `built` (set by the writer once a
    pass first ends with `pending === 0` and the listing not truncated; absent
    reads as `false`).
  - `docmap.json`: the v2 docmap's shape, unchanged.
  - `shards/`: shard revisions. A v4 manifest naming a key outside this prefix
    is refused.

A v3 manifest whose `format` differs from the configured one is a rebuild of
v3 (delete-the-manifest semantics; everything there is disposable). Building
a new format in its own namespace costs a full build while v2 keeps serving,
and two indexes are stored during the switch; building in place would serve a
mixed-tokenizer index that no query can score consistently.

Every key either layout produces has a dot segment, so `isPlumbing` and
`defaultIsIndexable` already hide it.

## Readers

A layout is `{ namespace, manifestKey, docmapKey, shardKeyFor(id, manifest) }`
(`shards/io.js`). For v2, `shardKeyFor` is `shardKey(id)`; for v3 it is
`manifest.shards[id]?.key ?? null`, and a `null` key reads as an empty shard
without a store op.

`loadIndexManifest` keeps its signature. When `store.searchIndexFormat` is
non-default and usable (`usesV3`; a usable format with `namespace: "v3"` also
counts, which is the bench and test hook for tokenizer 1 without chunking in
this namespace, and no deployment var sets it) it reads the v3 manifest first and serves it only if it
parses, its `format` equals the configured one and `built` is true. Every other
outcome (absent, unparseable, a read that throws, not built, another format)
reads and serves v2 exactly as before. With the default format no `v3/` key is
read at all, so default search costs and returns what it did. The returned
manifest carries `layout` and `format`; `loadDocmapPaths`, `loadCensus` and the
shard reads (`fetchShardBytes`, `loadShard`) follow it, so link resolution and
the graph census read the namespace search serves.

Version 4 is parsed only by `parseManifestV4`. It refuses version 3 or older,
any newer version, a `format` this build does not understand, a `shards` array
whose length is not `shardCount` and any entry whose key or digest is not a
string. The v2 reader (`parseManifest`) refuses version 4. A gateway that
predates this never looks under `v3/`, so rolling the code back serves v2.

A query is parsed, scored and its snippet lines cut with the tokenizer of the
manifest actually served (`manifest.format.tokenizer`), never the configured
one: tokenizer 2 configured while v2 still serves queries with tokenizer 1.

## The writer (Task 31)

`route.js` sets `store.searchIndexFormat = indexFormatFor(env)` per request,
beside `searchSubrequestBudget`, and the move queue consumer sets it on its
job store the same way. `syncShardedIndex` (`shards/syncDual.js`) runs one
`syncPass` (`shards/sync.js`) per namespace that needs it, with the writer
from `shards/revisions.js`. With the default format that is one v2 pass, byte
for byte as before (fixed shard keys, unconditional shard writes, the manifest
conditional on its etag and unconditional when absent, v1 cleanup); nothing
under `v3/` is read or written. `test/searchV2Frozen.test.mjs` pins that to a
digest computed from the pre-Task-31 code.

**The served index never freezes.** With the switch on and the v3 manifest
for this format not yet built, every pass, the write path's targeted one
included, first runs the v2 pass exactly as with the switch off and then gives
the v3 build whatever budget is left (an interactive backfill allowance is
shared, v2 first). The pass reports `pending`, `listingTruncated` and
`manifestOverflow` over both, so a caller keeps scheduling passes until v3 is
built too. Once that manifest is built, readers serve v3 and only v3 is
maintained; deciding this costs one read of the v3 manifest per pass. A v3
manifest of another format is not built for this one, so v2 maintenance
resumes on a format change.

The v3 pass runs against the v3 layout with these differences only:

- **Revisions.** A touched shard is stored at
  `.context/search/v3/shards/<nnn>-<hex16>.json`, `nnn` the zero-padded shard
  id and `hex16` the first 16 hex characters of the SHA-256 of the stored body
  (ruling OPEN-58). `shards[id]` names that key and the full 64-hex digest;
  readers trust the key and do not re-hash. An unchanged shard keeps its
  entry. Revision keys always stay under `.context/search/v3/shards/` and never
  contain a `..` segment; `parseManifestV4` refuses one that does not.
- **Never rewritten.** A revision put is create-only where
  `store.capabilities.conditionalCreate`; refused means the same content
  address is already stored. A body equal to the one the manifest already
  names is not written again.
- **One commit point.** The manifest is written after every revision it names
  has landed, conditional on the etag read at the top of the pass, or
  create-only (`onlyIf: { absent: true }`) where none existed and the store
  supports it, else unconditionally. A pass that loses writes no docmap and
  leaves its revisions unreferenced; Task 32 collects them. A pass that dies
  partway leaves the previous manifest serving, with every revision it names.
- **`built`** becomes true on the first full (listing) pass that ends with
  `pending === 0` and the listing not truncated, and stays true.
- **Tokenizer and chunks.** Notes are indexed with the format's tokenizer. A
  chunked format indexes each ordinary note as the chunks
  `chunkNote(path, text, format.chunk)` returns, one document `path#c<n>` per
  chunk with `notePath: path`; channel-day notes keep their message
  documents, and a note with no chunks (empty or encrypted) keeps its one
  whole-note document. Each chunk document carries `chunk` (its index),
  written in the shard only when set, so v2 shard bytes are unchanged. Chunk
  titles and anchors are Task 36.
- **v1 cleanup** is the v2 writer's job only.
- One log line per pass, `{"event":"search-index-format", workspace,
  namespace, tokenizer, chunk}`, with no path or term.

Revisioning applies to v3 only (ruling OPEN-74): the v2 writer keeps fixed-key
unconditional shard writes in Phase 5. Letting the served v2 index fall behind
while v3 builds is forbidden (see "The served index never freezes" above): a
note written while the switch is on must be findable whichever layout is
served. On a store that ignores preconditions (B2, Wasabi) the v3 pass
completes but coherence between concurrent passes is not claimed, as for v2.

## Queries and chunked results (Task 33)

- **Words only on the query side.** `parseQuery(query, 2)` uses
  `queryTermsOf`: tokenizer 2 without the CJK two-character pieces the index
  side adds (ruling OPEN-48). Every query term is a term the indexer stores
  for the same text. Snippet lines are still cut with `termsOf`, the index
  side, because a matched term can be a piece.
- **CJK fallback, tokenizer 2 only.** A query term containing a CJK run whose
  visible df is 0 is scored as its distinct two-character pieces
  (`cjkPieces`), on the docs that hold every piece, each piece at its own df,
  credited to the original term (so coverage counts it once). This runs
  before prefix and trigram expansion, which still run when any piece is
  absent or no doc holds them all. The shard walk gathers the pieces
  (`gatherTermsFor`), so routing and collection see them.
- **One result per note (ruling OPEN-61, README 12.5).** Each chunk is scored
  as a document. `rankedVisibleTo`, after the visibility filter, keeps the
  best-scoring entry per `notePath` among entries carrying `chunk`, with the
  union of `matchedTerms` over that note's chunks; channel-day message
  documents stay one result each. The result key is the note path. The
  scorer's 50-result cap counts notes, not chunk documents, so
  `matchCountIsFloor` still reads a full list as a floor. A query whose terms
  fall in two chunks of one note misses the coverage multiplier that a
  whole-note index would give it; Task 37 measures that.
