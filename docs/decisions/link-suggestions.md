# Link suggestions

_See `docs/decisions/README.md` for the index. Phase 4 of the link graph
(`docs/design/link-graph/PLAN.md`; per-task rulings in
`docs/design/link-graph/TASKS-PHASE-3-4.md`). It builds on the graph and
`related_notes` recorded in `docs/decisions/link-graph.md`. The code is
`apps/mcp/src/graph/changes.js`, `suggest.js` and `afterWrite.js`._

### Link suggestions ride write_note's text, on a budget of their own (Tasks 21 to 24)

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

**The budget model** (Phase 4 final review fix). The graph update keeps its
own budget of `WRITE_ENRICH_SUBREQUEST_BUDGET` per write, exactly as before
suggestions existed (Phase 3), so nothing about suggestions can change what a
write projects. Suggestions spend a separate budget: through the route, one
pool of `WRITE_ENRICH_SUBREQUEST_BUDGET` for the whole invocation, so a
legacy JSON-RPC batch shares a single suggestion ceiling (the agent loop
makes no writes; its writes are proposals); elsewhere, a budget of that size
per write. They have no other cap. A write's budgeted post-commit ops are
therefore at most twice the budget, and a batch's at most the budget per write
plus one budget for all its suggestions; move-job reads are outside the budget
(about two per finished move per write). Consequences:

- Suggestions run only where the deployment raised the budget above its
  default of 8 (unset, as on a self-host). At 8 or less a pass could only be
  partial, so they do not run and there is no block: a configuration, not a
  result, and the write's text is unchanged. `skipped` is kept for runtime
  causes, including a pool spent by earlier writes in the same batch. Budget 0
  turns the graph off too, so it remains the kill switch for all post-commit
  work. The hosted `apps/mcp/wrangler.toml` sets 80 for production and
  staging.
- Every write in a batch projects at any budget, as on the Phase 3 head.
  Earlier writes' suggestions can leave later writes in the same batch less
  for suggestions, or none (`skipped`); they never touch a graph update's
  budget.
- An earlier version of this round drew graph updates from the shared pool,
  holding a floor of 8 for each write still to project. That starved earlier
  writes' projection whenever later writes were announced (budget 8 with two
  writes projected one), so it was removed.

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
**Share links and labels (owner decision, 2026-10-07).** Share links do not
narrow the audience; they label the block. A block with candidates opens with
the written note's own visibility (`this note is team.`) and gives each
candidate its visibility in brackets: `private`, `team` or the `@group`. The
words "shared publicly" are added only on the owner's writes (scope
`private`, which only the owner holds): `suggestAfterWrite` makes one
control-plane call, `store.links.list()`, started after the encrypted/drawing
skip so it overlaps retrieval inside the 250 ms deadline and runs past it only
when slower than the whole pass. A note is labelled when an active link with
audience `anyone` opens it or a folder above it, and the note is team-visible
(a link opens only what the team can read, so a private or group note under a
linked folder is not labelled). `members`, `name` and `email` links are not
"public" and are not labelled. A listing that fails, answers `null`, is not an
array, or is absent (no control plane) gives no public labels; nothing is
guessed. A teammate's write makes no call and its block never carries the
label, so it learns nothing new: candidate and note visibility are rule
lookups on notes it can already read. Measured cost per write: store ops are
identical with and without the listing (`writeSuggestions.test.mjs`, "owner
write: one link listing ..."); one control-plane POST on an owner write, zero
on a teammate's.

**Both directions.** Each candidate line hints "link to it from this note";
it adds ", or back from it" when the writer may edit the candidate (the
write_note destination rule with no read: the owner may edit any path
`writesOneRule` accepts, a team connection only team-visible notes) and every
reader of the candidate can read the written note (the audience rule reversed,
so a back-link never shows a narrower note's path to wider readers; this second
condition is an implementer choice beyond the owner's wording). The guidance
changed from "do not rewrite a note just to add links" to "you may add a link
back where the relationship is real" in `suggest.js` GUIDANCE,
`mcp/instructions.js` and the `write_note` description; `linkGuidance.test.mjs`
checks the new phrase and the absence of the old one. The longest label (a
66-character group name) with both hints still fits the 4 KiB cap
(`graphSuggest.test.mjs`).

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
- **Freshness**, as for `related_notes` (`link-graph.md`): graph health and index freshness
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
private note's path to a team note's writer. Drawing graph updates from the
shared suggestion pool starves writes' projection in a batch. Letting ops start
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
- Budget: `writeSuggestions.test.mjs`, "a budget at or under the default of 8
  (configuration) omits the block; the write is today's exactly",
  "post-commit ops: the graph update alone stays within
  WRITE_ENRICH_SUBREQUEST_BUDGET, and suggestions add at most as much again",
  "six writes sharing one suggestion pool at 80 all project", "one
  invocation's pool bounds every write's suggestions together; each graph
  update keeps its own budget", "a legacy JSON-RPC batch of six writes at
  budget 80: every note projects and every write carries a block", "a batch's
  reads hold nothing back: nine read_note then one write_note at 80 still
  suggests" and "graph updates keep their own per-write budget: legacy
  batches at 8 (2, 3 writes) and 80 (11, 12 writes) project every note";
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
