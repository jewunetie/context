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
non-default and usable it reads the v3 manifest first and serves it only if it
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

The writer is Task 31; until it lands nothing writes under `v3/`.
