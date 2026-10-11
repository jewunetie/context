/**
 * Shared helpers of the search sync (budget counter, wave runner, note filter,
 * size caps). The v1 single-object sync loop that lived here was removed; the
 * sharded pass in `shards/sync.js` is the only one.
 *
 * One bounded pass per search: read the stored index, list the notes, diff by
 * etag, re-index as much of what changed as the budget allows, write it back
 * conditionally. The failure this module exists to remove is measured, not
 * hypothetical: a 154-note context answered every unprefixed search with
 * "Too many subrequests", because the brute-force scan fetched every note.
 * Cloudflare's free tier allows 50 subrequests per invocation, so **every**
 * store call here goes through one counter and a search can never spend more
 * than the caller allowed.
 *
 * The index is a **disposable derivative** (CLAUDE.md, plain-files rule), and
 * three consequences of that are deliberate rather than omissions:
 *
 * - It is **not snapshotted**. Nothing here is any more — version history is
 *   the customer's own object versioning at their provider — and a derivative
 *   rebuildable from the notes would be the last thing to reinstate it for.
 * - It is **not written to `.context/audit/`**. The audit trail records what a person
 *   or an agent did to somebody's notes; nobody did this, and an audit line per
 *   search would bury the lines that matter.
 * - It **never gates correctness**. Anything this pass could not finish comes
 *   back as `pending` / `listingTruncated` rather than being papered over, and
 *   a caller that gets an exception falls back to the bounded scan.
 *
 * The index contains text drawn from private notes — acceptable inside the
 * customer's own bucket, beside those notes, and never acceptable in what
 * leaves the gateway. Nothing in this module filters by visibility, because
 * nothing in this module returns anything to a caller: `canSee` is applied to
 * every result by the gateway, after this returns.
 */

/**
 * At most this much of one note's content is indexed.
 *
 * An ordinary note is estimated at a few KB and the outliers are saved chat
 * sessions and agent ledgers at 64KB+ — an estimate, never measured, and said
 * as one because every other number in this file is a measurement and an
 * unmarked guess beside them reads as one. Indexing the outliers whole is what
 * bloated the index past the memory ceiling.
 *
 * The first N characters carry a note's frontmatter, title and opening prose —
 * the parts ranking weighs most — and, on a long note, only the headings that
 * fall inside them, since `extractFields` runs on the sliced text.
 *
 * At 8KB the recall lost really was "the tail of the largest logs". At 2KB
 * that sentence is no longer true and saying it anyway would be the comment
 * describing the number it used to hold: on the estimate above an ordinary
 * note is now indexed by its opening rather than to its end, and a term deep
 * inside one does not match. That is a real loss of recall on ordinary notes,
 * accepted because an index that cannot be parsed loses all of them — and it
 * is said out loud to the caller on a miss (`toolSearchNotes`) rather than
 * left as a silent wrong answer. The cut is by characters of source text,
 * before tokenization, so `len` and tf stay consistent with what was actually
 * indexed.
 *
 * 2KB, down from 8KB. What is measured is that **8KB failed**: a live workspace in
 * the mid-thousands of notes built a capped index that still crossed
 * the removed index byte cap, so every pass refused it, rebuilt the same first
 * budget's worth of notes, and coverage never accumulated — the churn the cap's
 * comment predicted before the write side existed, arriving well before the
 * 10k-note guess. (That churn is now a plateau; what 8KB proved is that a
 * mid-thousands workspace crosses the parse cap, which is why this number moved.)
 * 2KB is a four-fold extrapolation from that measurement rather than a second
 * measurement, and it should be read as one: it holds a few-thousand-note
 * workspace under the parse cap by arithmetic, not by observation. The durable fix
 * at the next order of magnitude is sharding, not a smaller number here — and
 * a smaller number is now visibly expensive, because it costs recall on
 * ordinary notes rather than on 64KB logs.
 */
export const NOTE_INDEX_CHAR_CAP = 2_048;
/**
 * Does `value` encode to more than `cap` bytes of UTF-8?
 *
 * The read side compares `bytes.byteLength`, so the write side has to answer
 * in the same currency or the two disagree on exactly the buckets that need
 * them to agree: a CJK index runs three bytes to the character, so a check
 * counted in UTF-16 code units would store an object at up to three times the
 * cap and then refuse it on every read after — the same defect wearing a
 * different alphabet.
 *
 * **It counts without allocating**, which is the whole reason it is not one
 * line of `new TextEncoder().encode(value).byteLength`. Encoding to measure
 * spends a second full copy of the body — up to twelve megabytes, beside the
 * ~24MB UTF-16 string it is copying — inside the 128MB limit this cap exists
 * to respect. An earlier version did encode, and excused it as a narrow band
 * the two bounds below would usually skip; that was backwards. An ASCII index
 * has one byte to the code unit, so **everything from `cap/3` to `cap` — the
 * entire useful range for a Latin-script bucket — is the band**, and the
 * bounds spared only CJK-heavy or absurdly long bodies. Measured at twelve
 * million characters the scan costs 44ms against 12ms for encoding, and the
 * 12MB it does not allocate is the trade.
 *
 * The two bounds stay because they are exact and O(1): UTF-8 is never *fewer*
 * bytes than the string has UTF-16 code units, and never more than three per
 * unit (a surrogate pair is two units and four bytes; a lone surrogate is one
 * unit and becomes U+FFFD, three). So a string longer than the cap is over it
 * and one under a third of the cap is under it, without looking at a
 * character. In between, the scan walks code units and stops the moment the
 * running total crosses.
 *
 * Being a hand-written second copy of one line of `TextEncoder`, it is held
 * the way two copies of any rule are held here — **both run against a corpus**,
 * in `searchIndexer.test.mjs`, exhaustively over every BMP code unit and over
 * a seeded pseudo-random corpus carrying astral pairs and unpaired surrogates
 * of both halves. Reading it is not the check; the count in that file is.
 */
export function exceedsUtf8Bytes(value, cap) {
  if (value.length > cap) return true;
  if (value.length * 3 <= cap) return false;
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A well-formed pair is one code point in four bytes. Consume both units;
      // anything else — including a lone surrogate of either half — is the
      // three-byte replacement character, which is what `TextEncoder` emits.
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > cap) return true;
  }
  return false;
}

/**
 * The shared subrequest counter. Every `get`, `put` and `list` this module
 * performs takes one, and `reserve` is how a caller keeps ops back for work it
 * will do after this returns (snippet reads). A caller that constructs the
 * budget itself still holds it when a sync throws, which is what lets the
 * fallback scan know how much of the invocation is left.
 */
export function createSearchBudget(total) {
  let remaining = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  let spent = 0;
  return {
    get remaining() {
      return remaining;
    },
    get spent() {
      return spent;
    },
    /** Spend one store op without dipping into `reserve`; false if it cannot. */
    take(reserve = 0) {
      if (remaining <= reserve) return false;
      remaining -= 1;
      spent += 1;
      return true;
    },
  };
}

/**
 * Run `task` over `items` in waves of at most `size`, results in input order.
 *
 * Every remote read this module and `shards.js` make is independent of the
 * others in its wave — separate folders, separate shards, separate notes — so
 * awaiting them one at a time buys nothing and costs a round trip each. That
 * is a wall-clock cost the subrequest budget cannot see, and it is the one the
 * measurements in this file's neighbours are about: a warm search over a
 * 7,961-note bucket spent 57 store operations and **1,439ms** at a simulated
 * 20ms per operation, because 55 of the 57 were serialized.
 *
 * The wave is bounded rather than unbounded for two reasons that are not the
 * same reason. Cloudflare allows a Worker **6 simultaneous open connections**,
 * so a wider wave does not go faster — the extra requests queue — and it hides
 * how much is in flight from anybody reading the code. And a wave holds every
 * response it has received until the slowest of them lands, so an unbounded
 * wave over shard objects is the whole-corpus heap `shards.js` exists to
 * remove, wearing a `Promise.all`.
 *
 * Nothing here spends budget: the caller takes its ops before it builds the
 * wave, exactly as the sequential loops did, so a wave cannot overspend a
 * counter it never touches.
 */
export async function inWaves(items, size, task) {
  const width = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1;
  const results = [];
  for (let start = 0; start < items.length; start += width) {
    const wave = items.slice(start, start + width);
    results.push(...(await Promise.all(wave.map(task))));
  }
  return results;
}

/**
 * The default note filter: `.md`, no dot-prefixed segment, and not one of the
 * two root plumbing keys the gateway keeps outside the note surface.
 *
 * The gateway passes its own `isPlumbing`-backed predicate, so there is one
 * authority in the worker and this is not a second one. It exists so the module
 * stands alone (self-hosting, tests), and `searchIntegration.test.mjs` asserts
 * a real gateway search never lands `privacy.md`, `scopes.yml` or a dot-segment
 * key in the index — a duplicated rule that nothing checks is the "guard nobody
 * has checked" failure CLAUDE.md names.
 */
export function defaultIsIndexable(key) {
  if (typeof key !== "string" || !key.endsWith(".md")) return false;
  if (key === "privacy.md" || key === "scopes.yml") return false;
  return !key.split("/").some((segment) => segment.startsWith("."));
}
