# The search index: revisioned shards, one tokenizer, chunks and anchor text

This extends [`CONTRACT.md`](./CONTRACT.md), whose "sharded index" section
keeps the shard design and the reasons for it. Everything here is disposable:
the index is a derivative of the notes and is rebuilt from them.

## One format, no switch

`search/format.js`. There is one tokenizer (`text.js`: Porter2 on Latin-script
words, identifier splitting, Latin accent folding, `Intl.Segmenter` words and
CJK two-character pieces), chunked ordinary notes (`CHUNK`: target 1,000
characters, at most 1,500, 64,000 per note; the smallest size that met the
decision rule, ruling OPEN-66) and the anchor-text field. None of them has a
deployment var, a flag or a second behavior. `INDEX_FORMAT_VERSION` (6) is the
manifest's `version`. A stored manifest of any other version is read as absent
and the index is rebuilt, so bump it whenever the tokenizer, the chunk shape
or the stored layout changes. Version 5 was the previous index format.

If the runtime's `Intl.Segmenter` fails its self-test (`segmenterSelfTest`),
nothing is served and nothing is written: `loadIndexManifest` answers `null`
and `syncShardedIndex` returns without touching the store. There is no second
tokenizer to fall back to.

## Layout

Everything is under `.context/search/index/`:

- `manifest.json`, **version 6**: `shardCount`, `generatedAt`, per-shard
  `stats`, routing `filters`, `freshness`, `shards` (one `{ key, digest }` per
  shard id, or `null` for nothing stored) and, when non-empty, `anchorRefresh`.
  It is the single commit point. A `null` key over a shard whose stats count
  documents is refused.
- `docmap.json`: the diff surface, unchanged in shape.
- `shards/<nnn>-<hex16>.json`: shard revisions, content addressed. A manifest
  naming a key outside this prefix, or one holding `..`, is refused.
- `gc.json`: the revision collector's state.

The older `.context/search/v2/` and `.context/search/v3/` objects, and v1's
`search-v1.json`, are never read, written or deleted by this code. They are
orphans that cost storage only.

Every key has a dot segment, so `isPlumbing` and `defaultIsIndexable` already
hide it.

## Readers

`loadIndexManifest` reads `manifest.json` and nothing else (one op). It
answers `null` for an absent, unreadable, oversized, corrupt or
other-version manifest. There is no `built` flag: a manifest is served from
its first commit, as the sharded index always was. `loadDocmapPaths`,
`loadCensus` and the shard reads (`fetchShardBytes`, `loadShard`) follow it; a
shard's key comes from `manifest.shards[id]`, and a `null` key reads as an
empty shard without a store op.

**While the first index builds.** With no manifest, search answers from the
bounded literal scan (`degraded: true`, the "scanned N of M notes" note when
the scan could not cover the bucket) and starts the build behind the response.
After the first pass commits, search answers from the index and says "the
search index is still catching up on this context" while `freshness.pending`
is above zero. It never answers "(no matches)" out of an index that has not
been built.

## The writer

`syncShardedIndex` (`shards/sync.js`) is one pass; the writer is
`INDEX_WRITER` (`shards/revisions.js`).

- **Revisions.** A touched shard is stored at
  `.context/search/index/shards/<nnn>-<hex16>.json`, `nnn` the zero-padded
  shard id and `hex16` the first 16 hex characters of the SHA-256 of the
  stored body (ruling OPEN-58). `shards[id]` names that key and the full
  64-hex digest; readers trust the key and do not re-hash. An unchanged shard
  keeps its entry.
- **Never rewritten.** A revision put is create-only where
  `store.capabilities.conditionalCreate`; refused means the same content
  address is already stored, believed only after `store.exists` confirms it
  (a logical-delete tombstone can refuse a put over a deleted key). A body
  equal to the one the manifest already names is not written again.
- **One commit point.** The manifest is written after every revision it names
  has landed, conditional on the etag read at the top of the pass, or
  create-only where none existed and the store supports it, else
  unconditionally. A stored manifest of another version parses as absent but
  still has an etag, so the rebuilt manifest replaces it conditionally. A
  pass that loses writes no docmap and leaves its revisions unreferenced; the
  collector deletes them. A pass that dies partway leaves the previous
  manifest serving, with every revision it names. A search whose refresh pass
  lost the race answers from the manifest that pass built.
- **Anchor reads need `visibilityOf`.** A pass without it (a write's own
  targeted pass, or a miss's refresh) indexes notes without the anchor field,
  marks them `ANCHORS_UNREAD` and does not retry them; a pass that has
  `visibilityOf` re-reads them (see "Anchor text").

On a store that ignores preconditions (B2, Wasabi) the pass completes but
coherence between concurrent passes is not claimed.

## Queries and chunked results (Task 33)

- **Words only on the query side.** `parseQuery(query)` uses
  `queryTermsOf`: the tokenizer without the CJK two-character pieces the index
  side adds (ruling OPEN-48). Every query term is a term the indexer stores
  for the same text. Snippet lines are still cut with `termsOf`, the index
  side, because a matched term can be a piece.
- **CJK fallback.** A query term containing a CJK run whose
  visible df is 0 is scored as its distinct two-character pieces
  (`cjkPieces`), on the docs that hold every piece, each piece at its own df,
  credited to the original term (so coverage counts it once). This runs
  before prefix and trigram expansion, which still run when any piece is
  absent or no doc holds them all. The walk routes and collects on the
  query's own terms only (`gatherTermsFor`). After the first read and the
  expansion wave, a CJK term with visible df 0 routes its pieces as one more
  rung within the same budget (`pieceShards.js`): the shards whose filter may
  hold every piece are read, an already-read shard again for the pieces only
  (its doc count, lengths and vocabulary zeroed so nothing counts twice). A
  term that hit directly never routes or collects its pieces.
- **One result per note (ruling OPEN-61, README 12.5).** Each chunk is scored
  as a document. `rankedVisibleTo`, after the visibility filter, keeps the
  best-scoring entry per `notePath` among entries carrying `chunk`, with the
  union of `matchedTerms` over that note's chunks; channel-day message
  documents stay one result each. The result key is the note path. The
  scorer's 50-result cap counts notes, not chunk documents, so
  `matchCountIsFloor` still reads a full list as a floor. A query whose terms
  fall in two chunks of one note misses the coverage multiplier that a
  whole-note index would give it; Task 37 measures that.

## Chunked notes (Task 36)

`subDocumentsFor(path, full)` (`commsIndex.js`) is the one place a note
becomes documents.

- **Document shape (ruling OPEN-53).** An ordinary note
  is one document per `chunkNote(path, text, CHUNK)` chunk:
  `{ key: "<path>#c<n>", notePath: path, anchor: null, chunk: n, content,
  comms: null }`. `anchor` stays `null`, because `visible.js` sends any string
  anchor to `messageSegmentFor` and would drop the hit; a chunk hit's snippet
  is cut from the whole note. Channel-day notes keep their message documents,
  and a note with no chunks (empty, or encrypted, whose indexable text is
  empty) keeps its one whole-note document.
- **Comments and drawings.** Comment blocks (`comments.cjs`) are stripped
  before chunking, so a block cut by a chunk boundary is never indexed in part;
  the cap counts the note's own words. A drawing (`*.excalidraw.md`) is not
  chunked: it stays one whole-note document, its text when that fits in `cap`.
  A longer drawing is parsed and indexed as a short digest (frontmatter, every
  label, link targets; `drawingDigest` in `commsIndex.js`) instead of being cut
  mid-payload, with `partial` only when the element limit, an unreadable
  payload or the digest's own cut lost something. `extractFields` reads a
  drawing's words from the parsed file, which a fragment is not.
- **Titles.** Chunk 0's content is its text. A later chunk's content is the
  note's first heading, as one `# <title>` line, followed by the chunk text, so
  `extractFields` titles every chunk as it titles the whole note (the heading
  `extractFields` picks: after frontmatter, comments removed; a note with no
  heading gets no line). Tags come from frontmatter, which only chunk 0 holds.
  Title terms are therefore counted once per chunk; the note keeps its best
  chunk, so this moves ranking only within one note's title class.
- **The cap and `partial` (ruling OPEN-55).** Only the first `CHUNK.cap`
  (64,000) characters of a note are chunked. The last chunk of a note cut there
  carries `partial: true`, written in the shard only when true. `statsOfShard`
  collects those notes into `partialPaths`, written in the manifest's `stats`
  only when non-empty, and `shedNotePathsOf`
  returns shed and partial paths together. Callers see them only through the
  existing visibility-filtered `reducedRecall`/`reducedRecallNotes` (and the
  orientation shed signal), with the same "reduced recall" wording for both
  causes. A note edited under the cap loses the flag on its next index.
- **Volume and placement (ruling OPEN-60).** `indexVolumeOf(path, size)`
  counts an ordinary note as `min(size, CHUNK.cap)`, so `chooseShardCount` and the load `placeUnclaimed`
  measures see a long note's real volume. Chunked ordinary notes keep hash
  placement (`shardOf`); only bundled (channel-day) notes are placed by load. A
  shard that still overflows sheds and reports it, never silently.

## Collecting revisions (Task 32, ruling OPEN-59; fix round 1)

`collectShardRevisions(store, budget, { manifest, now })` (`shards/gc.js`)
looks at one page (200 keys) of `.context/search/index/shards/` and deletes a
revision only when all of these hold: its key is under that prefix and has the
revision name shape `<nnn>-<hex16>.json`; the current manifest does not name
it; its listed `uploaded` is known and older than the retention window of
15 minutes (`REVISION_RETENTION_MS`); and it is not protected as recently
superseded. A listing with no usable `uploaded` (missing, epoch 0,
unparsable, in the future) keeps the revision. Nothing outside the prefix is
ever listed or deleted, and a manifest that is absent or has no `shards`
means nothing is known to be referenced, so nothing is read or listed.

**The window runs from supersession.** A reader that pinned a manifest seconds
before it was replaced may read every revision it names, however old their
upload. The state object `.context/search/index/gc.json` (beside the shard prefix,
never listed by the collector) records `current`, the revision keys the
manifest named when a pass last looked, and `observedAt`. A pass that finds a
different set adds `{ at: now, after: observedAt, keys: <old set> }` to
`retained`; those keys, and any unreferenced revision uploaded after
`observedAt` (a manifest that came and went between two passes), are kept
until the window has passed since `at`. A pass with no valid state protects
everything for one window and deletes nothing.

**Progress is stored.** A logical-delete tombstone stays in the provider's
listing, and a run of kept keys at the front would pin a cursor-less pass to
the same first page. The state keeps the listing cursor between passes; a
finished listing clears it, which wraps the next pass to the start; a pass cut
short by the budget keeps its old cursor and reads the page again. A cursor the
provider refuses restarts the listing. The object is read from the bucket, so
only the exact shape and bounds the collector writes are accepted (at most 512
keys per list, 8 `retained` entries, 1024 characters of printable cursor);
anything else is no state.

`maintainNow` calls it after the search sync, with the sync's own manifest, when
`budget.remaining` exceeds `GC_BUDGET_FLOOR` (2) plus the projection reserve
(a pass that could not finish building has little left, and the floor keeps
the collector from taking the last ops). A pass spends one op for the state read, one for the listing, one per
delete and one for the state write, and every op leaves the floor untouched. A
failure is swallowed: it never changes the maintenance result.

**Deletes are logical where the store wraps them.** `store.delete` through
`withLogicalDelete` writes a tombstone, and a create-only put over a tombstone
can be refused for an object that is gone. A revision put that returns `null`
is therefore believed (the same bytes are already stored) only after
`store.exists(key)` confirms it; otherwise `putShard` returns `false`, the
shard counts as not persisted and the manifest never names it.

## Anchor text (always on)

`search/anchors.js`. Each note's first document gets a fifth field: the
display texts of the links pointing at it and their source notes' titles. A
target that is encrypted gets none.

**Recorded by the graph, always** (`graph/facts.js`, PARSER_VERSION 3, so graphs
from older code rebuild). A wikilink's alias (`[[B|alias]]`) or an inline link's
label (`[label](b.md)`) is stored as `text` on the occurrence; a link with
neither (`[[B]]`, an embed, a URL) has none. The record stores `title` (the
search title: first heading, else the file name). Each `incoming:` and `bare:`
posting entry carries `texts` and `title`, and both are part of
`referenceSetVersion`, so an alias or title edit rewrites the entries (a title
edit rewrites every membership of the note). Encrypted notes have none.

Caps:

| Cap | Value | Where |
|---|---|---|
| characters per display text | 64 (`ANCHOR_TEXT_CHARS`) | graph record |
| distinct texts per posting entry | 8 (`ANCHOR_TEXTS_PER_ENTRY`) | graph posting |
| characters per title | 120 (`ANCHOR_TITLE_CHARS`) | graph record |
| posting pages read per family per note | 1, page 0, at most 256 entries (`ANCHOR_POSTING_PAGES`) | index time |
| sources per note | 32, in posting order (`ANCHOR_SOURCES_PER_TARGET`) | index time |
| refresh list on the manifest | 256 paths, oldest dropped (`ANCHOR_REFRESH_CAP`) | manifest |

So one entry adds at most 8 x 64 + 120 characters to a posting page, and one
document's field at most 32 x (8 x 64 + 120) characters.

**Index time.** When the sync indexes note B it reads page 0 of
`incoming:<hash of B's path>` and, when B's file name is held by no other note
the pass knows, `bare:<hash of B's name>` (late binding, arch 7.4), from the
graph's active generation (one graph manifest read per pass; a missing or newer
graph gives no anchor text). Entries are not validated against node records;
a source the pass does not know (deleted) is skipped. A source is admitted only
when its visibility is at least as wide as B's: `narrowerVisibility(vis(A),
vis(B)) === vis(B)` with the privacy engine's own rules, so team into private
or a group, a group into private, equal into equal; never private into team or
a group, never a group into team or another group. The field is stored on the
document as `anchors: { text, sources }` with `len.anchors`, and its terms get
a fifth tf slot. A document with no admitted source keeps four slots.

**Query time.** No graph read. BM25F with weight `ANCHOR_FIELD_WEIGHT` 0.5 and
`b` 0.5 (`shardQuery.js`), against body's 1.0 and 0.75. A caller who cannot
see every source in `anchors.sources` gets the document without the field: its
tf slot, its df contribution and its length are dropped for that caller. That
is the guard after a visibility change no re-index has reached yet.

**Budget.** The graph manifest is read only when one note and its two posting
reads would still fit after it. A new or changed note is fetched as before; its
anchor reads take what the pass can spare, and when they cannot be paid its
version is recorded with `ANCHORS_UNREAD` appended. The diff then sees it as
stale, and a later pass re-reads it as anchor-only work: after every other note
in its shard, with its reads paid before the fetch, and never counted in
`pending`, so it does not hold back the build, which progresses at
`DEFERRED_SYNC_FLOOR` at that budget (searchAnchorText.test.mjs).
`censusFromManifest` strips the mark, so the graph and the D1 projection see
the real version.

**Freshness.** The graph reports which link targets' postings a projection
changed (`touched`). After a write (`graph/afterWrite.js`) those notes are
re-indexed by a targeted pass with ANCHOR_REFRESH_OPS (24) ops of its own;
after a reconciliation pass (`search/maintenance.js`) on what the graph left,
which keeps 3 ops back for it. A refresh a pass cannot finish stays on the
manifest (`anchorRefresh`) and every later pass of any kind picks it up. The
bound: an edit or delete of A through Context refreshes B behind the same
write; an edit or delete outside Context refreshes B in the maintenance pass
whose graph sweep reaches A, or a later pass if that one runs out. Past
ANCHOR_REFRESH_CAP queued paths the oldest are dropped, and B keeps the old
text until B is re-indexed for another reason (lean ceiling; a rotating anchor
re-read is the upgrade). A write's own targeted pass has no `visibilityOf`, so
the written note keeps its previous anchor field and is marked for a re-read;
a pass without `visibilityOf` does not retry marked notes, since it could not
read them either.

