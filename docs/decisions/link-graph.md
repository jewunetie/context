# Link graph

_See `docs/decisions/README.md` for the index. The design is
`docs/design/link-graph/README.md` (owner decisions) and
`docs/design/link-graph/PLAN.md`; the per-task rulings are in
`docs/design/link-graph/TASKS.md` (Phases 0 to 2) and
`docs/design/link-graph/TASKS-PHASE-3-4.md` (Phases 3 and 4). The code is
`apps/mcp/src/graph/`._

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
  reconciliation and garbage collection, so no graph store op runs. Readers
  honour it too (Phase 3 final review), since the graph it leaves is frozen:
  moves never trust postings (`indexedReferrerKeys` returns null and the
  move scans, with zero graph ops), and the gateway's `related_notes` skips
  the graph entirely, returning text hits only, labelled possibly
  incomplete. The console's panel calls the same `retrieveCandidates`
  through Convex, whose environment has no such switch: it reads the
  graph whatever the gateway's budget says, and only the docmap filter
  above keeps its candidates to notes the index lists. The tests are
  `graphRetrieve.test.mjs` "the kill switch (writeEnrichBudget 0) skips the
  graph: no graph op, labelled possibly incomplete" and
  `relatedNotesTool.test.mjs` "with the kill switch on, a move makes no
  graph op and related_notes serves no graph, labelled".
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
  graph part of the merged answer keeps the one bit above. Search's own read count also
  depends on hidden data once the index has more than one shard (the shard
  count follows the total note count, and routing reads filters built over
  private vocabulary), so a strict caller searches only when the budget left
  after the catalog covers every occupied shard, the hits and the expansion
  re-check's reserve, and otherwise gets no text hits at all (fix round 1).
  A strict caller's answer at a given budget is therefore one of four: both
  parts, graph withheld, text withheld, or both withheld.
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
  nothing removes, so every call pays unbudgeted reads that grow with move
  history: an indexed move one per historical move, and related_notes two
  (one in the seed lookup, which resolves the path through read_note's move
  overlay, and one in the retrieval). The answer does not change with move
  history. The tests are `relatedNotesTool.test.mjs`, "one active move plus
  100 finished ones: the answer at the default budget is the no-history
  answer, the moving note withheld" and "a refresh racing a new move's first
  sentinel never lets related_notes show the moving note", and
  `moveSentinel.test.mjs`, "a refresh between a new move's first sentinel and
  its marker does not hide the move".

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

**What "covered" means (controller ruling OPEN-23, Task 13 and its fix
round).** `graphHealth().complete` says a sweep wrapped; it says nothing about
writes since (arch 11.1: the index is not a completeness oracle). So the
sweep also records `sweepCensusAt`, and `graphHealth` reports it as
`coveredThrough` only when `complete` is true. It is the listing time of the
census the sweep *started* on (the search manifest's `freshness.listedAt`,
stamped before the listing is taken), not the wall clock and not the wrapping
pass's census: a note swept early and edited before the wrap is not
revisited. It is `null` unless every pass of the sweep ran on a complete
census with nothing pending in search (a note search could not fetch keeps
its old version in the census, so the sweep would skip its edit), and a
cursor time later than the wrapping census (skewed or hostile) is published as
`null`. A move then reads, besides the posting referrers and the moved notes,
every visible note listed at or after `coveredThrough` minus the margin
(inclusive), or with no usable listing time.

**When a move scans instead.** Every path below returns `null` from
`indexedReferrerKeys`, and `rewriteReferences` reads every visible note as it
did before Phase 3:

- the graph is not `complete` or has no `coveredThrough`, which includes every
  best-effort store (PLAN decision P4: those always scan);
- a renamed path is not a `.md` note (attachments have no `incoming/`
  postings, OPEN-5);
- a logical move job is active, or the job listing or a marker cannot be read
  (OPEN-25, fail closed: postings are keyed by physical paths, the overlay
  presents logical ones);
- the store may copy server-side (`serverSideCopy: "same-store"`), because a
  copy may keep the source's listing time and slip under the top-up; gateway
  stores never declare it (the logical-delete wrapper forces false, and
  Dropbox moves re-upload);
- a posting chain is incomplete, including a chain that reached
  `MAX_POSTING_PAGES` (a writer drops entries once a chain is full);
- the collaboration heads cannot be listed within the budget, or the budget
  runs out anywhere else, or any read throws.

Every visible note with collaboration state is read too, as the scan reads it:
its accepted text may never have reached the `.md`, and the postings describe
stored bodies only. **Owner decision point (Task 14 re-review):** every
collaborative read creates a head, so after one scanned move every eligible
note in a collaborative workspace is a candidate and the index saves little
there. Including every head is the cheapest complete rule; the lever is
upstream (a move-time read of a note with no head need not create one).

**What reversing it costs.** Trusting `complete` alone, recording the wall
clock, or recording the wrapping census lets a referrer edited after its sweep
visit keep a broken link while the move reports the rewrite done, which is the
arch 11.1 failure. Dropping any scan fallback does the same for the case it
guards. Removing the index path entirely costs only speed: moves read every
visible note again (at least 200 body reads instead of at most 5 in the
200-note test).

**The tests that fail if it is reversed.** All under `apps/mcp/test/`:

- Coverage time: `graphCoverage.test.mjs`, "a wrapped sweep on a complete
  census records the census listing time, not the wall clock", "a sweep
  spanning passes records the listing time of the pass that started it", "a
  wrap on a truncated census records nothing, and a sweep begun on one records
  null", "a note search could not fetch (freshness.pending > 0) never lets
  coveredThrough pass its edit", "an edit after the listing but before the
  pass ends is not behind coveredThrough" and "a mid-sweep cursor time later
  than the wrapping census is never published"; `graphManifest.test.mjs`,
  "coveredThrough is null whenever complete is false".
- Same result as the scan: `moveIndexedReferrers.test.mjs`, "single move:
  same bodies, audit row and counts as the scan, with fewer body reads",
  "batch move: same result as the scan", "folder move: same result as the
  scan" and "200 notes, 3 referrers: the index reads fewer note bodies than
  the scan".
- Top-up: `moveIndexedReferrers.test.mjs`, "a note edited after the sweep and
  never projected is rewritten via the top-up".
- Scan fallbacks: `moveIndexedReferrers.test.mjs`, "a graph that is not ready
  falls back to the scan and still rewrites everything", "a truncated posting
  chain falls back to the scan", "a best-effort store always scans and reads
  no node or posting", "a budget too small for the posting reads scans", "a
  folder move that includes an attachment scans", "an active logical move job
  scans", "a move-job listing that fails scans", "an unreadable move-job
  marker counts as active and scans", "a budget that cannot list the
  collaboration heads scans" and "a store that may copy server-side scans;
  Dropbox never declares it"; `graphPostings.test.mjs`, "reader: a chain of
  exactly MAX_POSTING_PAGES pages is not complete (a writer drops entries once
  it is full)".
- Collaborative referrers: the two cases in `moveIndexedReferrers.test.mjs`
  that begin "a collaborative referrer whose accepted edit", one for an edit
  before the sweep and one after.
- Privacy: `moveIndexedReferrers.test.mjs`, "a team caller's move never reads
  a hidden referrer the postings name, and counts match the scan".

### `related_notes` is a read-only convenience, and a strict caller learns at most a few workspace-level bits from it (Tasks 15 to 19)

`related_notes` (`apps/mcp/src/tools/related.js`) and the console's "Linked
and related notes" panel (`relatedNotes` action, `RelatedPanel.tsx`) answer
one question about one note the caller can already read: which visible notes
relate to it, and why. It is a convenience, not a new capability (arch 14):

- **Read-only, and nothing else changes.** `readOnlyHint: true`, so read-only
  sessions get it; it is in neither `PRIVATE_TIER_ONLY_TOOLS` nor
  `EXISTENCE_MASKED_TOOLS`; `search` and `fetch` are untouched. It returns
  only paths the caller may see that the search index's docmap still lists
  (a graph candidate outside the visible docmap paths is dropped, because
  postings outlive a move or delete until a sweep) and that are not under an
  active move. Those are the notes `list_notes` and `search_notes` show,
  except while the index is behind: a note moved or deleted since the
  index's last pass can still be listed until it catches up (the answer is
  then labelled possibly incomplete whenever a text query runs, from
  search's own incomplete-index report; an encrypted seed asks none). The
  test is `graphRetrieve.test.mjs`
  "a graph candidate that is not in the visible docmap paths is never
  returned" and `relatedNotesTool.test.mjs` "after a note moves out of
  sight, related_notes never shows its old path".
- **A hidden note and a missing one answer the same.** The seed resolves
  exactly as `read_note` resolves a path, move overlay and forwarding
  included, and both refusals are `not found` at the same raw op count. The
  exception is inherited from `read_note`, not closed here: a hidden move
  destination costs one op more than an absent path. The console's operation
  returns the `read` operation's not-found, byte for byte (and, like `read`,
  is one op cheaper for a hidden path).
- **No counts, no health, no unresolved links in the tool** (OPEN-35:
  diagnostics live in the console, on the note a person can fix). The limit
  defaults to 10 and is clamped to 1..25 (OPEN-34); it is applied after
  authorization. Evidence is note text and is printed as a JSON string, with
  U+2028, U+2029 and U+0085 escaped, so it cannot forge output lines.
- **The panel never shows a confident empty list** while loading, offline, on
  error, or when the answer is labelled possibly incomplete; the empty
  sentence appears only for a complete, empty answer.

**What a strict caller can still learn.** A strict caller is any scope but
exactly `private` (a team caller, or the owner through a team-scoped
session). These are the accepted residuals of controller rulings OPEN-27 and
OPEN-33, each an owner decision point. None reveals a path, a count, content
or a ranking of a hidden note; each says only that something somewhere is
hidden, large, moving or recent.

- **Graph reasons all or none.** Whether every posting chain finished within
  the budget depends on hidden entries, so a strict caller gets every graph
  family or none, labelled. Tests: `graphNeighbors.test.mjs`, "one bit at
  most: hidden notes that add a posting page in any family change nothing but
  the withheld label, at every budget"; `graphRetrieve.test.mjs`, "privacy
  invariance: hidden notes change nothing but the withheld graph bit, at
  tight and generous budgets".
- **Text hits all or none.** Search's cost depends on how many index shards
  are occupied, which grows with hidden notes, so a strict caller gets text
  hits only when the budget covers every occupied shard; a strict caller can
  learn that the index is larger than the budget. Tests:
  `graphRetrieve.test.mjs`, "text hits are all or none for a strict caller;
  the owner keeps them on an index larger than the budget" and "multi-shard
  privacy invariance: hidden notes change only the withheld text bit and the
  withheld graph bit, budgets 0..80".
- **A move is active somewhere.** While any logical move is active, notes
  under its source or destination are withheld and every answer is labelled
  possibly incomplete, even when the move is between two private folders.
  Tests: `graphRetrieve.test.mjs`, "a note under an active move's source or
  destination is withheld, and the answer is labelled" and "an unreadable
  move job withholds every candidate; a seed under a move gets nothing";
  `relatedNotesTool.test.mjs`, "during a logical move of a team folder into a
  private one, a team caller is never shown a note under it".
- **Freshness.** The possibly-incomplete label also follows workspace graph
  health and search-index freshness, which a hidden note's edit can flip.
  This one is accepted, not withheld, so no test proves it constant; the
  invariance tests hold health and freshness fixed, and these pin the label
  itself: `graphRetrieve.test.mjs`, "a best-effort store always labels
  possiblyIncomplete; a conditional, ready, converged one does not";
  `relatedNotesTool.test.mjs`, "a best-effort store labels its answer
  possibly incomplete".

Time taken also varies with each of these, as it does for search.

**What reversing it costs.** Listing partial graph families or partial text
hits for a strict caller turns each bit into a count of hidden entries.
Answering a hidden path differently from a missing one confirms that a
private note exists. Dropping the move withholding shows a note mid-move into
a private folder that `read_note` already refuses. Printing evidence raw lets
a note's text pose as tool output. Removing the tool loses nothing a caller
cannot rebuild from reads and searches, at many more calls.

**The tests that fail if it is reversed.** Besides the residual tests above,
`relatedNotesTool.test.mjs` (under `apps/mcp/test/`), "listed for a read-only
session, read-only and with a closed schema", "a team caller gets the same
answer for a hidden note and for a path that does not exist", "related_notes
and read_note make the same raw ops for a hidden path as for an absent one",
"a team caller's answer does not change with hidden notes that link to the
seed", "evidence is rendered as quoted data", "no Unicode line terminator from
evidence survives in the tool text" and "limit is clamped to 1..25";
`graphRetrieve.test.mjs`, "limit applies after canSee: hidden strong matches
do not reduce the visible count"; `apps/convex/__tests__/relatedNotes.test.ts`,
"a note outside the caller's clearance is the read operation's not-found,
byte for byte" and "a team answer does not vary with hidden notes";
`apps/mobile/__tests__/relatedPanel.test.ts`, "loading never says there are no
related notes", "the incomplete state shows its notice and no empty sentence"
and "a failed call is unavailable, not empty, and can be retried".
