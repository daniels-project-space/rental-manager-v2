import test from "node:test";
import assert from "node:assert/strict";
import {
  convexRunArguments,
  parseConvexRunOutput,
  reconcileRemusStockReview,
  runRemusStockReview,
} from "./run-remus-stock-review.mjs";

const clean = { dryRun: true, source: "Owned Remus master-stock reconciliation, 28 October 2026", reviewedOffers: 22,
  itemWrites: 0, productWrites: 0, rentalChanges: 0, messagesSent: 0 };
const repair = { ...clean, itemWrites: 5, productWrites: 22 };

test("targets only the reviewed Remus internal mutation with typecheck/codegen disabled", () => {
  assert.deepEqual(convexRunArguments(true), ["run", "seed/remus_stock_review:apply", "{\"dryRun\":true}", "--typecheck", "disable", "--codegen", "disable"]);
});

test("parses the command result without exposing unrelated CLI output", () => {
  assert.deepEqual(parseConvexRunOutput("Preparing function...\n" + JSON.stringify(clean)), clean);
  assert.throws(() => parseConvexRunOutput("not a result"), /no Remus stock review summary/);
});

test("requires a credential but never prints it", async () => {
  await assert.rejects(runRemusStockReview({ dryRun: true, key: "" }), /credential is unavailable/);
});

test("dry run reports the repair without applying it", async () => {
  const calls = [];
  const result = await reconcileRemusStockReview({
    verifyIdentity: async () => ({ deploymentUrl: "verified" }),
    run: async ({ dryRun }) => { calls.push(dryRun); return dryRun ? repair : { ...repair, dryRun }; },
  });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(calls, [true]);
});

test("apply runs only after review and is followed by a clean dry run", async () => {
  const calls = [];
  let writesRemaining = true;
  const result = await reconcileRemusStockReview({
    apply: true,
    verifyIdentity: async () => ({ deploymentUrl: "verified" }),
    run: async ({ dryRun }) => {
      calls.push(dryRun);
      if (!dryRun) return { ...repair, dryRun: false };
      if (writesRemaining) { writesRemaining = false; return repair; }
      return clean;
    },
  });
  assert.equal(result.mode, "applied-and-verified");
  assert.deepEqual(calls, [true, false, true]);
});

test("rejects an unexpected review plan before any write", async () => {
  let applyCalled = false;
  await assert.rejects(reconcileRemusStockReview({
    apply: true,
    verifyIdentity: async () => ({ deploymentUrl: "verified" }),
    run: async ({ dryRun }) => {
      if (!dryRun) applyCalled = true;
      return { ...repair, reviewedOffers: 21 };
    },
  }), /reviewed 22-offer Remus repair plan/);
  assert.equal(applyCalled, false);
});

test("does not apply changes after a clean production dry run", async () => {
  let calls = 0;
  const result = await reconcileRemusStockReview({
    apply: true,
    verifyIdentity: async () => ({ deploymentUrl: "verified" }),
    run: async ({ dryRun }) => { calls++; return dryRun ? clean : { ...clean, dryRun: false }; },
  });
  assert.equal(result.mode, "already-in-sync");
  assert.equal(calls, 1);
});
