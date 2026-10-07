/**
 * The staging check that the deployed Worker segments Chinese end to end
 * (Task 35, ruling OPEN-63). `staging-cli-live.mjs` writes a note holding
 * 数据库迁移计划已经确认 and calls this to search for 迁移 until it hits.
 * Tokenizer 1 reads the whole run as one token, so only a v3 index built with
 * tokenizer 2 can answer: a hit proves the Worker's `Intl.Segmenter` works and
 * the v3 index is built and served.
 *
 * Callers never see index counts (`visible.js`: withheld so a team connection
 * cannot subtract them from what it sees), so "built" and "pending" are read
 * from what a caller can see: a hit is `built`, and the "still catching up"
 * note is `pending`. The numbers themselves are operator-only, in the Worker's
 * `search` log line as `index.pending`.
 *
 * Known limit: a bucket with a permanently oversized shard never reaches
 * `built`, so v3 is never served there and this check fails as pending.
 *
 * Returns identifiers and booleans only, never note text.
 */

export const CATCHING_UP = "the search index is still catching up";

/**
 * @param {{ search: () => Promise<string>, path: string, sleep?: (ms: number) => Promise<void>, attempts?: number, delayMs?: number }} options
 * @returns {Promise<{ ok: boolean, built?: boolean, pending: boolean, attempts: number, reason?: string }>}
 */
export async function segmentsChinese({ search, path, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 30, delayMs = 4000 }) {
  let pending = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const text = await search();
    if (text.includes(path)) return { ok: true, built: true, attempts: attempt, pending: false };
    pending = text.includes(CATCHING_UP);
    if (attempt < attempts) await sleep(delayMs);
  }
  const reason = pending
    ? `no hit after ${attempts} searches and the index is still catching up: the v3 index may not be built yet, or this bucket has a permanently oversized shard, which never reaches built (v3 is then never served); pending and built counts are in the Worker's search log`
    : `no hit after ${attempts} searches with a complete index: the Worker is serving v2 (the Intl.Segmenter self-test failed) or the v3 index does not segment Chinese`;
  return { ok: false, pending, attempts, reason };
}
