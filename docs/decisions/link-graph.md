# Link graph

_See `docs/decisions/README.md` for the index. The design is
`docs/design/link-graph/README.md` (owner decisions) and
`docs/design/link-graph/PLAN.md`; the per-task rulings are in
`docs/design/link-graph/TASKS.md`. The code is `apps/mcp/src/graph/`._

### The reference index is approved, and it is a derivative that is never the authority

Context used to keep no reference index. `apps/mcp/src/forwarding.js` argued
that a second copy of every link would drift from files that Obsidian and
`rclone` also write, and that a stale reference is worse than none. The owner
approved reversing that (decision O1), on conditions. The conditions are the
decision; a tidy-up that drops one of them restores the failure the old
position was written to prevent.

The owner's three conditions (O1, `docs/design/link-graph/README.md`, Owner
decisions):

- **It is a rebuildable derivative under `.context/graph/v1/`.** Nothing in it
  is the only copy of anything. The links stay in the notes, and deleting the
  directory costs a rebuild and nothing else.
- **Every relationship is validated against the source's current version before
  it is returned.** A posting entry carries the `referenceSetVersion` of the
  record that wrote it, and `validateEntry` drops an entry whose source is
  missing, unparseable, excluded, or has since moved on to a different
  reference set. A delayed older write cannot make a removed link reappear.
- **It is never the authority for a canonical edit.** A later feature may use
  the graph to find candidate referrers. It must re-read the source and edit
  from the source, never from the index.

### How it is built (architecture and controller rulings, reversible at review)

These follow from the conditions but are not themselves owner decisions. Each
names its source, so a reader can tell what needs the owner and what needs only
a reviewer.

- **Graph code touches nothing outside `.context/graph/`** (architecture 2.2).
  Reconciliation never writes or deletes the forwarding ledger or any other
  `.context/` object. The rebuild (`rebuild.js`) is bound by the same rule:
  garbage collection deletes only the collected generation's own
  `g/<gen>/` prefix, never the serving, building or retained one, and only on
  a store with `conditionalDelete` (controller ruling OPEN-22). Its listing
  follows a cursor persisted with the maintenance cursor, because a
  logical-delete store turns each delete into a hidden marker that keeps its
  place in the listing, and it clears `collect` only after a traversal from the
  top lists nothing (Phase 2 final review).
- **Reads are filtered by `canSee`, per source, before validation**
  (architecture, same rule as the search index). A source the caller cannot
  see never appears and never reaches `validate`, because a posting page holds
  paths of private notes.
- **Encrypted notes are excluded entirely** (architecture 7.6; controller
  ruling OPEN-18). An encrypted body yields `coverage: "excluded"`, no
  occurrences, and no memberships, not even a bare-name entry.
- **The graph is bucket native and its health is stated, never assumed** (PLAN
  decision P4; controller ruling OPEN-10 and OPEN-13). On a store without
  conditional write and conditional create the graph still runs, with
  unconditional writes, but `graphHealth` labels it `possiblyIncomplete` and
  never `complete`, even after a clean sweep.
- **Graph work never affects a write** (PLAN decision P5; controller ruling
  OPEN-12 and OPEN-19). It runs behind the response where the store can defer,
  spends a per-write storage budget (`WRITE_ENRICH_SUBREQUEST_BUDGET`), and any
  failure is swallowed. It never changes a write's result or body. On a
  logical-delete store the wrapper's extra physical calls count against that
  budget too. Setting the budget to 0 is the graph's kill switch (Phase 2 final
  review ruling): the write hook spends nothing and search maintenance skips
  reconciliation and garbage collection, so no graph store op runs.
- **Moves and archive are left to reconciliation** (controller ruling
  OPEN-20). They go through `recordChange`, which has no body, so the write
  hook does not run for them. The same holds for referrers that a move
  rewrote and for form responses. Reconciliation shares the maintenance
  invocation with search, runs only when `GRAPH_PASS_FLOOR` budget is left
  after the search sync (controller ruling OPEN-21), and never changes the
  search sync's results or budget use.
- **A path leaves the graph only after a direct read of the note returns
  not-found** (controller ruling OPEN-15). That read is triggered either by a
  complete census that omits the path, or by a removal hint from the search
  sync, which works on an incomplete census too. An incomplete census on its
  own removes nothing.
- **Reconciliation takes turns, whatever the health** (controller ruling, Task
  11 fix round 3). Each pass's turn cycles sweep, audit, sweep, GC, stored in
  the maintenance cursor and advanced every pass. The piece whose turn it is
  runs first with the whole remainder of the pass; the others get what it
  leaves. With an incomplete census the audit does not run and its turns go
  to the sweep. Why: any piece that lives only on leftover budget starves for
  some census size, because a wrap can always leave less than its smallest
  unit of work, and keying turns on health starved GC and the audit whenever
  health stayed behind. Cost: catch-up projection on a large layout takes
  roughly twice the passes. The test is `graphRebuild.test.mjs`, "GC and the
  audit progress for every census size whether health is ready, stuck behind,
  or behind after a rollback".
- **Rollback ceiling: health stays behind while a newer build is unfinished**
  (controller ruling, Task 11 fix round 3; an owner decision point). Code older
  than any version label on a started build (`parserVersion`,
  `resolverVersion` or `urlKeyVersion`) keeps reconciling the active
  generation, so repair continues underneath, but it never builds into, cuts
  over or abandons that build, and it publishes the active generation's health
  as `behind`. After a rollback below any of those labels, `graphHealth`
  therefore stays `behind` with `complete: false` until newer code is
  redeployed and finishes the build. There is deliberately no auto-abandon:
  older code cannot tell a rolled-back build from one a newer worker is still
  running. If the newer build had already cut over, the manifest itself names
  the newer versions: older code then writes nothing to the graph (no write
  hook, no reconciliation) and `graphHealth` returns `unavailable` with
  `complete: false` until newer code returns (Phase 2 final review). The tests
  are `graphRebuild.test.mjs`, "older code during a newer build reconciles the
  active generation but never publishes it complete", and
  `graphGuards.test.mjs`, "graphHealth is unavailable (never complete) on a
  manifest labelled with any newer version".
- **A note's neighbourhood is computed per caller** (`neighbors.js`, Task 15;
  controller rulings OPEN-26 to OPEN-28 and OPEN-32). Outgoing links and
  unresolved references come from the body in the request, resolved against
  the caller's visible catalog; backlinks, shared targets and shared URLs come
  from one pinned generation with `canSee` applied before anything is counted,
  validated or scored, a hub's degree included. A bare-name backlink counts
  only when the name is unique in the caller's catalog (architecture 7.4). An
  encrypted seed gets backlinks only. **Residual, withheld rather than closed**
  (architecture 12.4, OPEN-27; an owner decision point): posting pages mix
  visible and hidden entries, so how many reads a chain costs, and whether it
  finishes within the budget, depends on hidden data. For a caller other than
  the owner (any scope but exactly `private`), every graph family is dropped
  when any chain did not finish, and the answer is labelled incomplete, so no
  partial list and no choice of surviving family varies with hidden data;
  what remains is one bit (withheld or not, and the time taken). Graph maps
  are returned in path order, never chain order, which also depends on hidden
  history (Task 15 fix round 1). The tests are `graphNeighbors.test.mjs`,
  "privacy invariance: hidden notes, links and citations leave a team
  caller's answer unchanged", "one bit at most: hidden notes that add a
  posting page in any family change nothing but the withheld label, at every
  budget", "result order does not depend on where hidden entries sat in the
  chain" and "an incomplete chain empties every graph family for a team
  caller and keeps partial lists for the owner".
- **Related-note candidates merge one lexical query with that neighbourhood**
  (`retrieve.js`, Task 16; controller rulings OPEN-29 to OPEN-31 and OPEN-33).
  The query words come from the seed's own text only (title, headings, then
  body words by frequency, link targets blanked); the parts run in a fixed
  order on the one budget, the visible catalog first, then search, then the
  graph. The graph goes last because its read count depends on hidden
  posting entries: run first, it would hand search a remainder that varies
  with hidden data, and search would then vary in which hits it returns. Last,
  it can only lose its own families, all at once for a strict caller, so the
  merged answer keeps the one bit above. Search's own read count also
  depends on hidden data once the index has more than one shard (the shard
  count follows the total note count, and routing reads filters built over
  private vocabulary), so a strict caller searches only when the budget left
  after the catalog covers every occupied shard, the hits and the expansion
  re-check's reserve, and otherwise gets no text hits at all (fix round 1).
  Explicit links rank ahead of
  text-only hits, the rest by reciprocal rank fusion (k = 60), `nearby` only
  breaks ties and is never a candidate of its own, and the result limit is
  applied after authorization. **Accepted residuals** (OPEN-33): workspace
  health (`graphHealth.possiblyIncomplete`) and search-index freshness are
  workspace-level, so a hidden note's edit can flip `possiblyIncomplete`;
  behind, the visible docmap paths are still passed and only a target outside
  them reads `unknown` instead of `missing` (`catalog.partial`), so the seed's
  links still resolve. And whether text hits are withheld depends on how many
  shards are occupied, which grows with hidden notes: a strict caller can
  learn that the index is larger than its budget (one more workspace-level
  bit). None reveals a path, count, content or ranking of a hidden note; a
  team caller can infer that something somewhere changed recently, or that
  the workspace is large. The tests are `graphRetrieve.test.mjs`, "privacy
  invariance: hidden notes change nothing but the withheld graph bit, at
  tight and generous budgets" (health and freshness held constant),
  "multi-shard privacy invariance: hidden notes change only the withheld text
  bit and the withheld graph bit, budgets 0..80", "a hidden edit that leaves
  the index behind does not drop the seed's rooted links" and "limit applies
  after canSee: hidden strong matches do not reduce the visible count".
  Move jobs are read first, fail closed (Task 17 fix round 1): candidates are
  physical paths and read_note answers through the move overlay, so every
  candidate under an active job's source or destination is withheld and the
  answer is labelled possibly incomplete; unreadable job state, or a budget
  too small to read it, gives the empty answer. Whether a move is active, and
  how many job markers there are to read, is one more workspace-level bit.
  The tests are "a note under an active move's source or destination is
  withheld, and the answer is labelled" and "an unreadable move job withholds
  every candidate; a seed under a move gets nothing".
  Every job marker is read, whatever the active-move sentinel says, and
  outside the retrieval budget: the same reads read_note's overlay makes, so
  related_notes, link suggestions and indexed moves withhold exactly the
  moves read_note answers through (fix round 3; a sentinel gate tried in
  round 2 could be removed by a racing refresh before a new move's marker
  landed). A finished move's marker delete is a logical-delete tombstone that
  nothing removes, so related_notes and indexed moves pay one unbudgeted read
  per historical move, like read_note; the answer does not change with move
  history. The tests are `relatedNotesTool.test.mjs` "one active move plus
  100 finished ones" and "a refresh racing a new move's first sentinel", and
  `moveSentinel.test.mjs`.

**What reversing it costs.** Phase 3 backlinks, related notes, and
index-assisted move repair all read this index; they cannot be built on a
reference index that is not allowed to exist. Reversing the conditions while
keeping the index is the more expensive mistake: unvalidated postings return
stale backlinks, an index treated as authority rewrites notes from stale data,
and an unfiltered posting read leaks the existence of private notes.

**The tests that fail if it is reversed.** All under `apps/mcp/test/`:

- Validation against the current record: `graphProject.test.mjs`,
  "validateEntry rejects an older delayed membership write after a newer
  projection" and "validateEntry rejects a missing, unparseable or excluded
  source and reports a budget stop"; `graphPostings.test.mjs`, "readPostings:
  validate drops stale referenceSetVersion; a throw marks incomplete".
- Privacy: `graphPostings.test.mjs`, "readPostings: a source canSee rejects
  never appears and never reaches validate".
- Disposable and confined to its prefix: `graphReconcile.test.mjs`, "nothing
  outside .context/graph/ is ever written or deleted"; `graphRecords.test.mjs`,
  "every key keys.js produces is plumbing and never indexable" and "key
  builders throw on bad segments and never leave the graph prefix";
  `graphRebuild.test.mjs`, "GC after the second cutover deletes only g/<old>/
  in bounded pages and nothing else" and "nothing outside .context/graph/ is
  written or deleted through a rebuild, two cutovers and GC".
- Encrypted notes excluded: `graphFacts.test.mjs`, "encrypted body is excluded
  with no memberships at all"; `graphProject.test.mjs`, "an edit to encrypted
  removes every prior membership"; `graphReconcile.test.mjs`, "an encrypted
  note in the census yields an excluded node with no memberships".
- P4 stores are labelled possibly incomplete: `graphManifest.test.mjs`,
  "best-effort store is always possiblyIncomplete and never complete, even
  after a complete sweep" and "a manifest written in conditional mode read by
  a best-effort store is labelled best-effort"; `graphPostings.test.mjs`,
  "graphMode is conditional only with both probed flags".
- Graph work never affects a write, and is budgeted: `graphWrite.test.mjs`,
  "budget 0: write result and body identical, no graph store op at all", "a
  graph store that throws on put or get never changes the write", and "total
  graph ops never exceed the budget, at any budget"; `graphGuards.test.mjs`,
  "kill switch: WRITE_ENRICH budget 0 makes zero graph store ops across writes
  and deferred passes" and "write path: raw graph subrequests on a
  logical-delete store never exceed the WRITE_ENRICH budget";
  `graphReconcile.test.mjs`,
  "maintainNow: a graph failure does not reach the caller" and "maintainNow:
  the search sync's results and budget use are unchanged when graph work runs".
- Moves and archive are left to reconciliation: `graphWrite.test.mjs`, "moves
  and archive do not call the hook (left to reconciliation)".
- Deletion needs a direct not-found: `graphReconcile.test.mjs`, "a path absent
  from a complete census but present in the bucket is never removed",
  "removedHints are confirmed by a direct read before removal" and "an
  incomplete census never removes anything".

### Moves read referrers from the graph only where it can vouch for them (Task 14)

`rewriteReferences` reads only the notes `indexedReferrerKeys`
(`apps/mcp/src/tools/moves/indexedReferrers.js`) names: the moved notes, the
`incoming/` and `bare/` posting sources of each renamed path, every note listed
at or after `coveredThrough` minus `TOP_UP_MARGIN_MS` (10 minutes), and every
note with collaboration state. Anything it cannot vouch for scans, as before:
a graph that is not complete, a best-effort store, a renamed attachment, a move
job that is active or unreadable, a store that may copy server-side, an
incomplete posting chain, or a budget that runs out.

**The margin stands in for a `reverseRepair` check (controller ruling, Task 14
fix round 1).** A node still owing `reverseRepair` after a same-note projection
race can be missing from its targets' postings. Finding such nodes would take
one node read per note, which is the scan's cost. Instead: a ready wrap means
no swept node owed repairs, so a node owing them now was projected after its
sweep visit by the write hook of a write seconds earlier, and that write's
listing time falls inside the margin. **Ceiling: a write hook delayed past
`TOP_UP_MARGIN_MS` after the census its sweep started on.** Such a referrer is
missed by that move until the next sweep, and its link stays stale. Hooks run
behind the response of the write's own invocation, far inside 10 minutes. If
that ever changes (a queued hook, a retry loop), raise the margin or read the
nodes. Test: `moveIndexedReferrers.test.mjs`, "a node still owing
reverseRepair, edited inside the margin, is read like the scan would".

### Link suggestions ride write_note's text, on one enrichment budget (Tasks 21 to 24)

After a plain `write_note` commits, the sections it changed seed
`suggestLinks`, and the block is appended to the write's existing text result
(`apps/mcp/src/tools/notes/write.js`, `apps/mcp/src/graph/afterWrite.js`,
`apps/mcp/src/graph/suggest.js`, `apps/mcp/src/graph/changes.js`). This is
owner decision O3 as built. Everything below it is a controller ruling,
reversible at review, unless it says otherwise.

**Only the plain `write_note` call gets suggestions (O3; controller ruling
OPEN-37).** `toolWriteNote` is also called by comments, forms and `remember`,
so the switch is opt-in: only the plain `write_note` branch of
`apps/mcp/src/tools/dispatch.js` passes `linkSuggestions: true`, and every
other caller is off without having to remember a flag. An opt-out would let a
future caller return suggestions against O3. No argument turns them on or off.

**What a write is diffed against, and what is skipped.** The pre-write body is
the merged collaborative document before this write, else the stored body,
else an empty create (OPEN-38); the committed text is the merged text when a
merge happened. `detectChangedSections` diffs them line by line (Myers, capped
at `MAX_EDIT_DISTANCE` 1,000 edits and `MAX_INPUT_CHARS` 256 Ki characters;
past either cap it takes a limited pass over the new text) and returns at most
two sections, most changed prose first. Frontmatter, code, and edits that only
add, remove or retarget link syntax are not seeds, so a follow-up write that
only adds the suggested links is `skipped` and cannot loop (AGENT-LINKS 13.7).
An encrypted note or a drawing is `skipped` before any retrieval: its
plaintext is never a query (OPEN-39).

**The block.** `{ status, basedOnEtag, candidates: [{ path, section, signals,
excerpt }] }`, rendered as plain lines: one guidance line with the AGENT-LINKS
13.2 substance, then one line per candidate (OPEN-44). At most three
candidates (`MAX_CANDIDATES`), deduplicated across sections; the source and
every target the committed text already links to are excluded, and linked
targets are dropped before the result limit so a heavily linked note still
gets text matches. Signals are `links_here`, `shares_target`, `shares_url` and
`text_match` (OPEN-42). The rendered block is at most 4 KiB of UTF-8
(`SUGGESTION_BYTE_CAP`, guidance included): sections and excerpts are cut
first, then the candidate whose line cannot fit is dropped. Every
candidate-controlled string is note data and is escaped of quotes,
backslashes, control and format characters and line separators, so it can
neither end its quotation nor start a line. The statuses:

- `ready`: candidates, and every retrieval complete.
- `partial`: candidates, but some retrieval was labelled possibly incomplete,
  or the deadline or budget cut a later section.
- `none`: no candidates, and at least one retrieval completed.
- `skipped`: no candidates and no retrieval completed, or nothing to diff, an
  encrypted note, a drawing, a spent pool or a passed deadline.
- `unavailable`: an exception inside the suggestion step. Store and search
  faults are not exceptions here (retrieval never throws), so they surface as
  `partial` or `skipped`.

On a best-effort store graph health is always possibly incomplete, so answers
there are only `partial` or `skipped`.

**The linking guidance travels with the tools, not only with candidates**
(Task 24; controller ruling OPEN-45). The AGENT-LINKS 13.2 substance is in the
connect-time instructions and in the `write_note` description, which every
client delivers; `orient` does not carry it. Both say a write "may" end with
suggestions, because `remember` and a budget of 8 or less return no block, and
an ineligible edit returns `skipped`.

**No `structuredContent` (Task 23 fix round 1, reversing the OPEN-43
recommendation).** The block is carried in the text block only, for every
protocol revision. Some clients pass only `structuredContent` to the model
when a result has one, which would hide the write's own lines (visibility,
share, form and status) behind the suggestions, and the 2025-06-18 revision
asks a tool that returns structured content to also return it serialized as
text. **Reversible** once the target clients are confirmed to keep `content`
beside `structuredContent`; the block's shape already exists.

**The per-write budget model.** Suggestions and the write's graph update
spend one enrichment pool, suggestions first and the graph update on what
remains: `WRITE_ENRICH_SUBREQUEST_BUDGET` per write, or, through the route,
one pool for the whole invocation, so a legacy JSON-RPC batch shares a single
ceiling (the agent loop makes no writes; its writes are proposals). Every
write keeps `GRAPH_FLOOR` (8, the Task 8 default) of the pool for its graph
update until that update has run, and the MCP handler announces a batch's
calls in advance, so each one's floor is held before it starts; suggestions
take only what exceeds every held floor, with no other cap. Consequences:

- A configured budget at or under one floor (8, the default where the
  variable is unset, as on a self-host) runs no suggestions and shows no
  block: a configuration, not a result, and the write's text is unchanged.
  `skipped` is kept for runtime causes. Budget 0 turns the graph off too, so
  it remains the kill switch for all post-commit work. The hosted
  `apps/mcp/wrangler.toml` sets 80 for production and staging.
- A batch's later writes still project: earlier suggestions cannot take
  their floors. A call that makes no write gives up its announced floor once
  it has been handled (Task 23 batch count fix), so reads earlier in a batch
  do not starve a later write's suggestions. **Ceiling:** calls not yet
  handled still hold a floor whether or not they will write, so a mixed
  batch holds back more than it needs until its reads have run; and a
  sequence of writes that nobody announced in advance could still starve a
  graph update, which reconciliation then repairs.

**The 250 ms deadline** (`SUGGEST_DEADLINE_MS`, AGENT-LINKS 13.5) starts before
the diff, so it covers the structural analysis too. After it, no store op
starts: the budget refuses every take, and a proxy over the store (forked
logical-delete views included) answers `get`, `list` and `head` with null
without reaching the store. A retrieval the deadline reached is dropped whole,
because how far it got depends on timing and, for a strict caller, on hidden
entries. Ops started before the deadline are awaited, so the step can end one
read's latency past 250 ms. A `Promise.race` would return earlier but leave
the read running on the invocation's subrequest counter. That overrun is
accepted.

**Who may be offered as a link target (controller ruling OPEN-40).** The
source note's visibility *after* the write decides, since the write may just
have changed it: a private source may be offered any candidate the caller can
see; a team source only candidates every team reader can see; a group-scoped
source only candidates a reader holding just that group can see; anything not
provably as broad is withheld (AGENT-LINKS 13.7). The rule is applied inside
retrieval's `canSeeKey`, so a withheld note never takes a ranked slot.
**Owner decision open: share links.** A team note with an active unlisted
share link still gets team candidates, whose paths an agent could then write
into a link-readable page. Share state is not in the bucket: it is a
control-plane call (`store.links.list()`), outside the store budget, answered
only for the owner, listing folder links that cover whole subtrees, and absent
on deployments without a control plane. Closing it needs the owner to decide
whether to spend that call per write, what non-owners get, and whether folder
links count. Until then it is a `lean:` comment at the audience rule in
`afterWrite.js`.

**What a strict caller can learn from the block.** A strict caller is any
scope but exactly `private`. Suggestions use the same retrieval as
`related_notes` (one call per changed section), so they carry the same
accepted residuals (OPEN-27, OPEN-33), now per section. None reveals a path, a
count, content or a ranking of a hidden note.

- **Graph reasons and text hits, all or none, per section.** Each section's
  retrieval can withhold its graph families, its text hits, or both, and the
  block's status steps from `ready` to `partial` (or `none` to `skipped`) with
  it. The second section's budget is what the first left, which can vary with
  hidden posting pages, so the allowed outcomes are the per-section
  combinations of those two bits. Tests: `graphSuggest.test.mjs`, "privacy
  invariance: for a team caller hidden notes change the block only by the
  documented withheld bits, single and multi-shard, budgets 0..80";
  `graphRetrieve.test.mjs`, "text hits are all or none for a strict caller;
  the owner keeps them on an index larger than the budget" and "multi-shard
  privacy invariance: hidden notes change only the withheld text bit and the
  withheld graph bit, budgets 0..80".
- **A move is active somewhere.** Candidates under an active move's source or
  destination are withheld and the answer is labelled, and unreadable move
  state withholds every section. Move jobs are read once per suggestion call,
  outside the budget but inside the deadline. Tests: `graphSuggest.test.mjs`,
  "unreadable move state withholds every section's candidates, read once" and
  "move jobs are read once per call, not once per section: 50 finished moves
  cost two sections what they cost one"; `graphRetrieve.test.mjs`, "a note
  under an active move's source or destination is withheld, and the answer is
  labelled".
- **Freshness**, as for `related_notes`: graph health and index freshness
  are workspace-level, and a hidden note's edit can flip them.

Time taken also varies with each of these.

**Subrequests per write (DELIVERY 16.3).** Raw store ops for one two-section
`write_note` update, through the worker test harness over a memory bucket with
logical delete (41 notes, ready graph, converged index), deferred work
included (Task 23 fix round 1):

| Finished moves | Budget 0 | Budget 8 | Budget 80 |
|---|---|---|---|
| 0 | 44 | 49 (no block) | 84 (`ready`) |
| 50 | 95 | 100 (no block) | 186 (`ready`) |

Cloudflare's limits page (read 2026-10-07) gives 50 subrequests per invocation
on Workers Free and 10,000 by default on Workers Paid, and counts R2 binding
calls as subrequests; `apps/mcp/wrangler.toml` records that the hosted
deployment is on Workers Paid.

- **Free tier (50).** Suggestions do not run there at the default budget of 8,
  and the write with its graph update is already at 49 with no move history.
  An earlier S3 measurement put a plain write alone at 26 to 60 subrequests.
  At the hosted budget of 80 a write is at 84, past 50. **Move history is the risk** (owner list, pre-existing): a
  finished move's marker is a logical-delete tombstone nothing removes, and
  the write already pays about one read per finished move (44 to 95 over 50
  moves at budget 0), so on these figures a free-tier write passes 50 after
  about six finished moves at budget 0 and two at the default 8, with or
  without suggestions. It needs a physical
  delete or tombstone cleanup for `.context/moves/`.
- **Hosted (10,000).** 84 ops at budget 80, growing about 2 per finished move
  (one for the write, one for suggestions; it was 3 before move jobs were read
  once per call), so on a straight-line extrapolation from these two points a
  write reaches 10,000 at about 4,900 finished moves.
- **Not measured:** real R2 or S3, real subrequest counts in a deployed
  Worker, and the hosted ceiling in a live run. These figures are store ops
  in tests, which equal subrequests only if every op is one call.

**What reversing it costs.** Opting out instead of in returns suggestions to
`remember`, comments or forms, against O3. Dropping the audience rule offers a
private note's path to a team note's writer. Taking suggestions before the
graph floors starves later writes' graph updates in a batch. Letting ops start
after the deadline lets a slow store hold the write's response. Rendering
candidate text unescaped lets a note pose as tool output. Removing the feature
entirely loses nothing a caller cannot rebuild with searches after a write.

**The tests that fail if it is reversed.** All under `apps/mcp/test/`:

- Which callers: `writeSuggestions.test.mjs`, "through dispatch: plain
  write_note gets the block; comments and forms never do and never search";
  `remember.test.mjs`, "remember never returns link suggestions or searches
  for them, on either path, while write_note does".
- The write is unaffected: `writeSuggestions.test.mjs`, "a plain write gets
  the block appended; text, note, audit row and index are otherwise today's",
  "kill switch: budget 0 is today's result exactly, with no graph or search
  op", "a search store that throws: the write is today's and the block says
  so without failing it" and "a throw inside the suggestion step itself is
  unavailable, never a failed write".
- Changed sections: `graphChanges.test.mjs`, "duplicate headings are told
  apart by position", "an edit under a nested heading maps to that heading's
  interval", "a pure link-wrap edit is skipped (AGENT-LINKS 13.3 step 6)",
  "code is not a seed: fenced, inline, and headings inside fences", "an input
  over the cap is a limited new pass within the cap" and "the edit-distance
  cap: exact under it, a limited pass over it, fast either way";
  `writeSuggestions.test.mjs`, "a link-only follow-up write is skipped, and
  its graph facts still update", "a collaborative merged write diffs the
  merged text: a link another edit added is not suggested again" and "an
  encrypted note is skipped without any retrieval".
- The block: `graphSuggest.test.mjs`, "a ready block: text matches by
  section, with excerpt, signals and the etag; source and linked target
  excluded", "a note with more outgoing links than the result limit still
  gets its text match", "signals: graph reasons pass through, related_text is
  text_match, nearby and linked_from_here never appear", "deduplicated across
  sections, attributed to the first, at most three", "rendered block stays
  within 4 KiB of UTF-8 with three long multibyte excerpts and headings;
  untrusted text is escaped", "format characters (\p{Cf}) in untrusted text
  are escaped", "none: a complete search that finds nothing worth returning"
  and "a throwing search store does not throw and returns no candidates
  (retrieveCandidates never throws)".
- Guidance: `linkGuidance.test.mjs`, "initialize instructions carry the
  linking guidance" and "the listed write_note description carries the
  linking guidance".
- Text only: `writeSuggestions.test.mjs`, "tools/call write_note: the block is
  in the text for every revision, never structuredContent".
- Budget: `writeSuggestions.test.mjs`, "a budget with nothing above the graph
  floor (configuration) omits the block; the write is today's exactly",
  "post-commit ops (suggestions plus graph) never exceed
  WRITE_ENRICH_SUBREQUEST_BUDGET", "the shared pool keeps a graph floor for
  every write of a batch still to project: six writes at 80 all project",
  "suggestions get the pool minus every pending graph floor, with no fixed
  cap", "one invocation's pool bounds every write in it together", "a legacy
  JSON-RPC batch of six writes at budget 80: every note projects and every
  write carries a block" and "a batch's reads stop reserving once handled:
  nine read_note then one write_note at 80 still suggests";
  `graphSuggest.test.mjs`, "budget.spent and the ops made never exceed the
  budget, budgets 0..80".
- Deadline: `graphSuggest.test.mjs`, "deadline: a clock that passes during
  CPU work (no I/O in between) starts no further op", "deadline: a retrieval
  the deadline reached is dropped whole, at every op it could pass after",
  "deadline: no store op starts after the clock passes, at every op of a
  crowded two-section write (snippet waves included)" and "deadline on a
  logical-delete store (the gateway's): forked views are cut off too";
  `writeSuggestions.test.mjs`, "deadline: once the injected clock passes it,
  no further search op starts".
- Audience: `graphSuggest.test.mjs`, "audience: a team source never gets a
  private candidate, even for the owner; a private source does" and
  "audience: a group source keeps team and same-group candidates, withholds
  another group's and private ones"; `writeSuggestions.test.mjs`, "a team
  note's write never suggests a private candidate; a private note's may" and
  "the write's own visibility change decides the audience: team to private,
  and private to team".
- Strict-caller residuals: the tests named under "What a strict caller can
  learn from the block" above.
