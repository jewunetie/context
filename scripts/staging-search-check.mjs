/**
 * The staging check that the deployed Worker segments Chinese end to end
 * (Task 35, ruling OPEN-63). `staging-cli-live.mjs` writes a note holding
 * 数据库迁移计划已经确认 and calls this to search for 迁移 until it hits.
 * A tokenizer without word segmentation reads the whole run as one token, so
 * only an index built with the Worker's `Intl.Segmenter` can answer: a hit
 * proves the segmenter works and the index is built and served.
 *
 * A hit is only believed after a control search for a substring of the note's
 * marker that no tokenizer produces as a term or prefix (`control`). If that
 * also hits, the literal scan answered rather than an index, so the run is
 * inconclusive, not a pass.
 *
 * Callers never see index counts (`visible.js` withholds them so a team
 * connection cannot subtract them from what it sees), so this check cannot
 * report them.
 *
 * Known limit: until the first index pass completes, search answers from the
 * literal scan, and a runtime whose segmenter fails its self-test serves no
 * index at all; either way this check fails with no hit.
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
  return { ok: false, attempts, reason: `no hit in ${attempts} attempts; the index may still be building, or the Worker segmenter failed its self-test` };
}
