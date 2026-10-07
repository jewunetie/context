/**
 * The move queue consumer's store carries the deployment's search settings,
 * so index updates from a materialized move reach the namespace search serves
 * (CONTRACT-v3.md "The writer"; Task 31 fix round 1).
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   `configureJobStore` does not set `searchIndexFormat`                     1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { configureJobStore } from "../src/moves/queueConsumer.js";
import { DEFAULT_FORMAT, indexFormatFor } from "../src/search/format.js";
import { searchBudgetFor } from "../src/search/budget.js";

test("the job store carries the configured index format and budget", () => {
  const env = { SEARCH_TOKENIZER: "2", SEARCH_SUBREQUEST_BUDGET: "600" };
  const store = configureJobStore({}, env);
  assert.deepEqual(store.searchIndexFormat, indexFormatFor(env));
  assert.equal(store.searchIndexFormat.tokenizer, 2);
  assert.equal(store.searchSubrequestBudget, searchBudgetFor(env));
  assert.deepEqual(configureJobStore({}, {}).searchIndexFormat, DEFAULT_FORMAT);
});
