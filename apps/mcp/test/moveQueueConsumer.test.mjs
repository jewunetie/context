/**
 * The move queue consumer's store carries the deployment's search budget,
 * so index updates from a materialized move spend what a request would.
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted.
 *
 *   `configureJobStore` does not set `searchSubrequestBudget`                1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { configureJobStore } from "../src/moves/queueConsumer.js";
import { searchBudgetFor } from "../src/search/budget.js";

test("the job store carries the configured search budget", () => {
  const env = { SEARCH_SUBREQUEST_BUDGET: "600" };
  const store = configureJobStore({}, env);
  assert.equal(store.searchSubrequestBudget, searchBudgetFor(env));
  assert.equal(store.searchSubrequestBudget, 600);
});
