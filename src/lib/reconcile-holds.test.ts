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
      order_step: "VERIFIED",
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

  // Test 13: renter_name propagates from reservation onto every hold
  it("propagates renter_name from reservation to all generated holds", () => {
    const res = makeRes({
      _id: "res_013",
      order_step: "BOOKED_AFTER_VERIFIED",
      start_date: "2025-06-16",
      end_date: "2025-06-17",
      items: [{ item_name: "Tent XL" }],
      renter_name: "Alice Rental",
    });

    const result = computeHoldsForReservations({
      reservations: [res],
      items: [ITEM_A],
      today: TODAY,
    });

    assert.equal(result.holds.length, 2, "should generate 2 holds");
    assert.ok(result.holds.every((h) => h.renter_name === "Alice Rental"), "all holds carry renter_name");
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

/**
 * Deterministic product_id resolution (added 2026-08-18).
 *
 * Regression cover for the live double-booking exposure: reconcile read
 * `items[]` (no product_id) instead of `hygglo_items[]` (product_id on 21/21
 * live lines), fell through to the LLM resolver, and produced a C-stand hold
 * for a "Cinema Tripod Stand" line while two genuinely rented Nanlite lights
 * got no hold at all and read as available.
 */
describe("computeHoldsForReservations — deterministic product_id path", () => {
  const CAM = makeItem({ _id: "item_cam", name: "Sony FX3", qty: 1 });
  const LENS = makeItem({ _id: "item_lens", name: "Sony GM 24-70mm f2.8", qty: 1 });
  const DECOY = makeItem({ _id: "item_cstand", name: "C-stand", qty: 1 });

  const oneDay = {
    order_step: "BOOKED_AFTER_VERIFIED",
    start_date: "2025-06-20",
    end_date: "2025-06-20",
  };

  it("resolves a line by product_id and ignores the LLM's wrong answer", () => {
    // expanded_items points at the DECOY — exactly the failure that happened
    // live. The product_id mapping must win.
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({
          _id: "res_1",
          ...oneDay,
          hygglo_items: [{ product_id: 999, name: "Sony FX3 Full-Frame Cinema Camera" }],
          expanded_items: [{ item_id: "item_cstand" }],
        }),
      ],
      items: [CAM, LENS, DECOY],
      today: TODAY,
      productIndex: new Map([["acme#999", "item_cam"]]),
    });
    assert.equal(result.holds.length, 1);
    assert.equal(result.holds[0].item_id, "item_cam");
    assert.equal(result.stats.resolved_by_product_id, 1);
    assert.equal(result.unresolvedLines.length, 0);
  });

  it("expands a bundle listing into every component it consumes", () => {
    // "FX3 Kit | 24-70" consumes TWO items; a single product_id -> item_id row
    // cannot express that, which is why the lens-only mapping lost the camera.
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({
          _id: "res_2",
          ...oneDay,
          hygglo_items: [{ product_id: 1000, name: "Sony FX3 Kit | 24-70" }],
        }),
      ],
      items: [CAM, LENS, DECOY],
      today: TODAY,
      bundleOverrides: new Map([
        ["acme#1000", [{ item_id: "item_cam", qty: 1 }, { item_id: "item_lens", qty: 1 }]],
      ]),
    });
    assert.deepEqual(
      result.holds.map((h) => h.item_id).sort(),
      ["item_cam", "item_lens"],
    );
  });

  it("RECORDS an unmapped line instead of silently dropping it", () => {
    // The core bug: a rented item nothing holds reads as "available". It must
    // surface, not vanish.
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({
          _id: "res_3",
          ...oneDay,
          hygglo_items: [{ product_id: 4242, name: "Nanlite Forza 300 LED Light Kit" }],
        }),
      ],
      items: [CAM, LENS, DECOY],
      today: TODAY,
      productIndex: new Map(),
    });
    assert.equal(result.unresolvedLines.length, 1);
    assert.equal(result.unresolvedLines[0].product_id, 4242);
    assert.match(result.unresolvedLines[0].title, /Nanlite/);
    assert.equal(result.holds.length, 0);
  });

  it("treats a mapping to a cross-account item as unresolved, not a hold", () => {
    const foreign = makeItem({ _id: "item_x", name: "Someone else's FX3", account_slug: "other" });
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({ _id: "res_4", ...oneDay, hygglo_items: [{ product_id: 7, name: "FX3" }] }),
      ],
      items: [foreign],
      today: TODAY,
      productIndex: new Map([["acme#7", "item_x"]]),
    });
    assert.equal(result.holds.length, 0);
    assert.equal(result.unresolvedLines.length, 1);
  });

  it("prefers the bundle override over a single-item index row", () => {
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({ _id: "res_5", ...oneDay, hygglo_items: [{ product_id: 55, name: "Kit" }] }),
      ],
      items: [CAM, LENS],
      today: TODAY,
      productIndex: new Map([["acme#55", "item_cam"]]),
      bundleOverrides: new Map([
        ["acme#55", [{ item_id: "item_cam", qty: 1 }, { item_id: "item_lens", qty: 1 }]],
      ]),
    });
    assert.equal(result.holds.length, 2);
  });

  it("leaves existing behaviour untouched when no maps are supplied", () => {
    // Guards the rollout: omitting the maps must reproduce today's output.
    const result = computeHoldsForReservations({
      reservations: [
        makeRes({
          _id: "res_6",
          ...oneDay,
          hygglo_items: [{ product_id: 999, name: "Sony FX3" }],
          expanded_items: [{ item_id: "item_cam" }],
        }),
      ],
      items: [CAM],
      today: TODAY,
    });
    assert.equal(result.holds.length, 1);
    assert.equal(result.holds[0].item_id, "item_cam");
    assert.equal(result.stats.resolved_by_product_id, 0);
  });
});
