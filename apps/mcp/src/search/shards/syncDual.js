/**
 * `syncShardedIndex`: one maintenance pass, over whichever namespaces need it
 * (CONTRACT-v3.md "The writer").
 *
 * With the switch off this is exactly one v2 pass (`syncPass` with the v2
 * writer), the same call with the same options as before v3 existed.
 *
 * With it on, the served index must never freeze: readers keep serving v2
 * until v3 is built (`loadIndexManifest`), so until then every pass, the write
 * path's targeted one included, runs the v2 pass first exactly as with the
 * switch off and then gives the v3 build whatever budget is left. Once the v3
 * manifest for this format is built, v3 is what readers serve, and only v3 is
 * maintained. Deciding that costs one read of the v3 manifest per pass.
 */

import { createSearchBudget } from "../maintain.js";
import { V2_WRITER, logV3Pass, writerFor } from "./revisions.js";
import { syncPass } from "./sync.js";

/**
 * Same options and result shape as `syncPass` (see `sync.js`). While v3 builds,
 * the result is the served (v2) pass's, except that `pending`,
 * `listingTruncated` and `manifestOverflow` also count the v3 build and
 * `committed` is true when either pass committed, so a caller scheduling
 * further passes keeps going until v3 is built as well.
 */
export async function syncShardedIndex(store, options = {}) {
  const v3 = writerFor(store);
  if (!v3.v3) return syncPass(store, options, V2_WRITER);

  const ops =
    typeof options.budget === "object" && options.budget ? options.budget : createSearchBudget(options.budget);
  const shared = { ...options, budget: ops };
  if (await v3IsServed(store, ops, options.reserve ?? 0, v3)) {
    const served = await syncPass(store, shared, v3);
    logPass(store, served, true);
    return served;
  }

  const before = ops.spent;
  const served = await syncPass(store, shared, V2_WRITER);
  // The v2 pass spent part of any interactive backfill allowance; the v3 build
  // gets the rest. Counted in ops rather than note reads, so it errs short.
  const backfillOps = Number.isFinite(options.backfillOps)
    ? Math.max(0, options.backfillOps - (ops.spent - before))
    : options.backfillOps;
  // The v3 pass diffs against the listing the v2 pass just took. Listing again
  // re-paid the walk out of the leftover, and at low budgets that left v3 no op
  // for a single note fetch, so it was never served (the Task 31 stall).
  const building = await syncPass(store, { ...shared, backfillOps, listing: served.listing }, v3);
  // `built` only once the manifest saying so was written; the pass sets the flag
  // on the in-memory manifest before it knows the write won.
  logPass(store, building, building.manifest?.built === true && building.committed);
  return {
    ...served,
    pending: served.pending + building.pending,
    listingTruncated: served.listingTruncated || building.listingTruncated,
    manifestOverflow: served.manifestOverflow || building.manifestOverflow,
    committed: served.committed || building.committed,
    spent: ops.spent,
  };
}

/**
 * The v3 log line for one pass. A pass that did not list (refused at the
 * reserve, a targeted pass with no v3 manifest, or a listing cut short before
 * it found a single note) knows nothing about pending, and `pending: 0` would
 * read as done.
 */
function logPass(store, pass, built) {
  const listing = pass.listing;
  const listed = Boolean(listing) && !(listing.truncated && listing.entries.size === 0);
  logV3Pass(store, {
    built,
    pending: listed ? pass.pending : null,
    truncated: listed ? pass.listingTruncated : true,
    oversizedShards: pass.oversizedShards,
  });
}

/** Whether readers serve v3 for this format now: its manifest parses and is built. */
async function v3IsServed(store, ops, reserve, v3) {
  if (!ops.take(reserve)) return false;
  try {
    const stored = await store.get(v3.manifestKey);
    if (!stored) return false;
    return v3.parseManifest(await stored.text())?.built === true;
  } catch {
    return false;
  }
}
