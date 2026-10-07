/**
 * The staging check that the deployed Worker segments Chinese end to end
 * (Task 35, ruling OPEN-63). `staging-cli-live.mjs` writes a note holding
 * 数据库迁移计划已经确认 and calls this to search for 迁移 until it hits.
 * Tokenizer 1 reads the whole run as one token, so only a v3 index built with
 * tokenizer 2 can answer: a hit proves the Worker's `Intl.Segmenter` works and
 * the v3 index is built and served.
 *
 * A hit is only believed after a control search for a substring of the note's
 * marker that no tokenizer produces as a term or prefix (`control`). If that
 * also hits, the literal scan answered rather than an index, so the run is
 * inconclusive, not a pass.
 *
 * Callers never see index counts (`visible.js` withholds them so a team
 * connection cannot subtract them from what it sees), so this check cannot
 * report them. They are operator-only: v3 `built` and `pending` are in the
 * Worker's `search-index-format` log line, one per v3 pass.
 *
 * Known limit: a bucket with a permanently oversized shard never reaches
 * `built`, so v3 is never served there and this check fails with no hit.
 *
 * Returns identifiers and booleans only, never note text.
 */

/**
 * @param {{ search: () => Promise<string>, control: () => Promise<string>, path: string, sleep?: (ms: number) => Promise<void>, attempts?: number, delayMs?: number }} options
 * @returns {Promise<{ ok: boolean, attempts: number, inconclusive?: boolean, reason?: string }>}
 */
export async function segmentsChinese({ search, control, path, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 30, delayMs = 4000 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if ((await search()).includes(path)) {
      if ((await control()).includes(path)) {
        return { ok: false, attempts: attempt, inconclusive: true, reason: "inconclusive: the control search also hit, so the literal scan answered rather than an index" };
      }
      return { ok: true, attempts: attempt };
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { ok: false, attempts, reason: `no hit in ${attempts} attempts; v3 built and pending are in the Worker search-index-format log` };
}
