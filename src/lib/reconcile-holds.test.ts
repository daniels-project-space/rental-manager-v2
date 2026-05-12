/**
 * reconcile-holds.test.ts
 *
 * Test runner: Node.js built-in `node:test` + `node:assert` (no vitest/jest
 * found in package.json devDependencies).
 *
 * Run with:
 *   npx tsx --test src/lib/reconcile-holds.test.ts
 * or:
 *   node --import tsx/esm --test src/lib/reconcile-holds.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeHoldsForReservations,
  type ReservationInput,
  type ItemRow,
} from "./reconcile-holds.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = new Date("2025-06-15T00:00:00.000Z"); // fixed for determinism

function makeItem(overrides: Partial<ItemRow> & { _id: string; name: string }): ItemRow {
  return { account_slug: "acme", ...overrides };
}

function makeRes(overrides: Partial<ReservationInput> & { _id: string }): ReservationInput {
  return {
    account_slug: "acme",
    start_date: null,
    end_date: null,
    ...overrides,
  };
}

const ITEM_A = makeItem({ _id: "item_001", name: "Tent XL" });
const ITEM_B = makeItem({ _id: "item_002", name: "Kayak", aliases: ["kayak pro", "sea kayak"] });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeHoldsForReservations", () => {

  // Test 1: BOOKED_AFTER_VERIFIED, 3-day span, 1 matching item → 3 holds
  it("generates 3 hold rows for a 3-day BOOKED_AFTER_VERIFIED reservation", () => {
    const res = makeRes({
      _id: "res_001",
      order_step: "BOOKED_AFTER_VERIFIED",
      start_date: "2025-06-16",
      end_date: "2025-06-18",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 3, "should generate 3 holds");
    assert.deepEqual(
      result.holds.map((h) => h.date).sort(),
      ["2025-06-16", "2025-06-17", "2025-06-18"]
    );
    assert.equal(result.holds[0].status, "confirmed");
    assert.equal(result.holds[0].item_id, "item_001");
    assert.equal(result.stats.holds_generated, 3);
    assert.equal(result.stats.reservations_processed, 1);
  });

  // Test 2: APPROVED → 0 holds, skipped_pending=1
  it("skips APPROVED reservations (skipped_pending=1)", () => {
    const res = makeRes({
      _id: "res_002",
      order_step: "APPROVED",
      start_date: "2025-06-16",
      end_date: "2025-06-18",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.equal(result.stats.skipped_pending, 1);
    assert.equal(result.deleteReservationIds.length, 0);
  });

  // Test 3: is_obsolete=true → 0 holds, deleteReservationIds=[that id]
  it("adds obsolete reservation to deleteReservationIds", () => {
    const res = makeRes({
      _id: "res_003",
      is_obsolete: true,
      order_step: "DELIVERED",
      start_date: "2025-06-16",
      end_date: "2025-06-18",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.deepEqual(result.deleteReservationIds, ["res_003"]);
    assert.equal(result.stats.skipped_obsolete, 1);
  });

  // Test 4: item_name not in items → unmatchedItemNames has it, 0 holds
  it("records unmatched item names and generates no holds for them", () => {
    const res = makeRes({
      _id: "res_004",
      order_step: "FUNDS_RESERVED",
      start_date: "2025-06-16",
      end_date: "2025-06-16",
      items: [{ item_name: "Invisible Widget" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.ok(result.unmatchedItemNames.includes("Invisible Widget"));
  });

  // Test 5: item_name matching an alias → resolves correctly
  it("resolves item via alias (case-insensitive)", () => {
    const res = makeRes({
      _id: "res_005",
      order_step: "VERIFIED",
      start_date: "2025-06-16",
      end_date: "2025-06-16",
      items: [{ item_name: "Sea Kayak" }], // alias, different case
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_B],
      today: TODAY,
    });

    assert.equal(result.holds.length, 1);
    assert.equal(result.holds[0].item_id, "item_002");
  });

  // Test 6: Date range entirely past (>30 days back) → 0 holds
  it("skips date ranges entirely older than 30 days", () => {
    const res = makeRes({
      _id: "res_006",
      order_step: "DELIVERED",
      start_date: "2025-04-01", // >30 days before 2025-06-15
      end_date: "2025-04-03",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.ok(result.stats.forward_cap_skipped >= 3);
  });

  // Test 7: Date range straddling forward cap → only days within cap generate holds
  it("only generates holds for dates within the forward cap window", () => {
    // today = 2025-06-15, forwardCapDays=5 → cap = 2025-06-20
    // Range 2025-06-18 → 2025-06-22 (5 days): only 18,19,20 pass
    const res = makeRes({
      _id: "res_007",
      order_step: "BOOKED_AFTER_VERIFIED",
      start_date: "2025-06-18",
      end_date: "2025-06-22",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
      forwardCapDays: 5,
    });

    assert.equal(result.holds.length, 3, "only 3 days within cap");
    assert.deepEqual(
      result.holds.map((h) => h.date).sort(),
      ["2025-06-18", "2025-06-19", "2025-06-20"]
    );
    assert.ok(result.stats.forward_cap_skipped >= 2);
  });

  // Test 8: RETURNED order_step → status = "completed"
  it("sets hold status to completed for RETURNED step", () => {
    const res = makeRes({
      _id: "res_008",
      order_step: "RETURNED",
      start_date: "2025-06-10",
      end_date: "2025-06-10",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 1);
    assert.equal(result.holds[0].status, "completed");
  });

  // Test 9: CANCELED order_step → deleteReservationIds, skipped_obsolete++
  it("adds CANCELED reservation to deleteReservationIds", () => {
    const res = makeRes({
      _id: "res_009",
      order_step: "CANCELED",
      start_date: "2025-06-16",
      end_date: "2025-06-16",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.deepEqual(result.deleteReservationIds, ["res_009"]);
  });

  // Test 10: Legacy fallback — no order_step, status="confirmed" → generates holds
  it("uses legacy status=confirmed when order_step is absent", () => {
    const res = makeRes({
      _id: "res_010",
      status: "confirmed",
      start_date: "2025-06-16",
      end_date: "2025-06-16",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 1);
    assert.equal(result.stats.skipped_pending, 0);
  });

  // Test 11: Legacy fallback — status="pending_review" → skipped
  it("skips legacy status=pending_review reservations", () => {
    const res = makeRes({
      _id: "res_011",
      status: "pending_review",
      start_date: "2025-06-16",
      end_date: "2025-06-16",
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 0);
    assert.equal(result.stats.skipped_pending, 1);
  });

  // Test 12: pickup_at / return_at override start/end dates
  it("uses pickup_at and return_at epoch overrides for date range", () => {
    const res = makeRes({
      _id: "res_012",
      order_step: "DELIVERED",
      start_date: "2025-01-01", // ignored when pickup_at present
      end_date: "2025-01-01",
      pickup_at: new Date("2025-06-14T10:00:00.000Z").getTime(),
      return_at: new Date("2025-06-14T18:00:00.000Z").getTime(),
      items: [{ item_name: "Tent XL" }],
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 1);
    assert.equal(result.holds[0].date, "2025-06-14");
  });
});
