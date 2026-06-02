/**
 * Pins the canonical reservation semantics. If any of these change you have
 * deliberately altered widget output — update the assertions AND verify each
 * affected dashboard query's snapshot before merging.
 *
 * Run: npx tsx --test src/lib/reservations/predicates.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type ReservationRow,
  dedupByLogicalRental,
  dedupKey,
  effectiveDate,
  isConfirmedWithDates,
  isEarned,
  isLive,
  isOngoing,
  isPendingVerification,
  isUpcoming,
  netOf,
} from "./predicates.js";

const TODAY = "2026-05-14";

function row(over: Partial<ReservationRow> = {}): ReservationRow {
  return {
    _id: "r1",
    _creationTime: 0,
    status: "confirmed",
    start_date: "2026-05-20",
    end_date: "2026-05-22",
    is_obsolete: false,
    ...over,
  } as ReservationRow;
}

describe("isLive", () => {
  it("excludes cancelled / declined / obsolete", () => {
    assert.equal(isLive(row({ status: "cancelled" })), false);
    assert.equal(isLive(row({ status: "declined" })), false);
    assert.equal(isLive(row({ is_obsolete: true })), false);
  });
  it("includes confirmed / pending_review / completed", () => {
    assert.equal(isLive(row({ status: "confirmed" })), true);
    assert.equal(isLive(row({ status: "pending_review" })), true);
    assert.equal(isLive(row({ status: "completed" })), true);
  });
});

describe("isConfirmedWithDates", () => {
  it("requires confirmed + dates + not obsolete", () => {
    assert.equal(isConfirmedWithDates(row()), true);
    assert.equal(isConfirmedWithDates(row({ status: "pending_review" })), false);
    assert.equal(isConfirmedWithDates(row({ is_obsolete: true })), false);
    assert.equal(isConfirmedWithDates(row({ start_date: undefined })), false);
    assert.equal(isConfirmedWithDates(row({ end_date: undefined })), false);
  });
});

describe("isOngoing / isUpcoming", () => {
  it("ongoing when today falls within [start, end]", () => {
    assert.equal(isOngoing(row({ start_date: "2026-05-14", end_date: "2026-05-22" }), TODAY), true);   // today, in window
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-22" }), TODAY), true);   // started early, still in window
    assert.equal(isOngoing(row({ start_date: "2026-05-20" }), TODAY), false);  // future start
    assert.equal(isOngoing(row({ status: "pending_review", start_date: "2026-05-14" }), TODAY), false);
  });
  it("not ongoing once end_date has passed, even if not marked RETURNED", () => {
    // Mirrors the dashboard-widget rule: a confirmed rental whose end_date is
    // before today disappears from active even if order_step is RETURNED or
    // DELIVERED (i.e. owner forgot to tick "returned" on Hygglo).
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "RETURNED" }), TODAY), false);
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "DELIVERED" }), TODAY), false);
  });
  it("upcoming when start > today", () => {
    assert.equal(isUpcoming(row({ start_date: "2026-05-20" }), TODAY), true);
    assert.equal(isUpcoming(row({ start_date: "2026-05-14" }), TODAY), false);
  });
  it("excludes pending-verification (order_step=VERIFIED) from BOTH ongoing and upcoming", () => {
    // 2026-06-02 consistency fix: a confirmed+dated row still in ID/doc
    // verification must not appear in the Active tab (nor the calendar) — it
    // belongs only in the pending bucket. Same universe on both surfaces.
    const verifiedOngoingShape = row({ start_date: "2026-05-14", end_date: "2026-05-22", order_step: "VERIFIED" });
    const verifiedUpcomingShape = row({ start_date: "2026-05-20", end_date: "2026-05-22", order_step: "VERIFIED" });
    assert.equal(isOngoing(verifiedOngoingShape, TODAY), false);
    assert.equal(isUpcoming(verifiedUpcomingShape, TODAY), false);
    // Sanity: the SAME rows without the VERIFIED step still classify normally.
    assert.equal(isOngoing(row({ start_date: "2026-05-14", end_date: "2026-05-22", order_step: "DELIVERED" }), TODAY), true);
    assert.equal(isUpcoming(row({ start_date: "2026-05-20", end_date: "2026-05-22", order_step: "BOOKED_AFTER_VERIFIED" }), TODAY), true);
    // And it IS still pending.
    assert.equal(isPendingVerification(verifiedOngoingShape), true);
  });
  it("honors negotiated return_date (extension) in the ongoing window", () => {
    // Raw end_date passed, but a chat-agreed return_date keeps it ongoing —
    // matches the Gantt bar now reaching displayReturnDate (FIX 2).
    assert.equal(
      isOngoing(row({ start_date: "2026-05-10", end_date: "2026-05-13", return_date: "2026-05-20" }), TODAY),
      true,
    );
    // Without the extension the same row is no longer ongoing (end < today).
    assert.equal(
      isOngoing(row({ start_date: "2026-05-10", end_date: "2026-05-13" }), TODAY),
      false,
    );
  });
});

describe("isPendingVerification (paid + verifying)", () => {
  it("only true when order_step === VERIFIED and not obsolete", () => {
    assert.equal(isPendingVerification(row({ order_step: "VERIFIED" })), true);
    // Active-step semantics: FUNDS_RESERVED means renter must pay → NOT pending.
    assert.equal(isPendingVerification(row({ order_step: "FUNDS_RESERVED" })), false);
    // APPROVED = owner accepted, renter hasn't paid → NOT pending.
    assert.equal(isPendingVerification(row({ order_step: "APPROVED" })), false);
    // REQUEST = owner hasn't accepted yet.
    assert.equal(isPendingVerification(row({ order_step: "REQUEST" })), false);
    // Verified but obsolete (verification failed) → excluded.
    assert.equal(isPendingVerification(row({ order_step: "VERIFIED", is_obsolete: true })), false);
  });
});

describe("effectiveDate", () => {
  it("pickup_date wins, falls back to start_date", () => {
    assert.equal(effectiveDate({ pickup_date: "2026-05-15", start_date: "2026-05-14" }), "2026-05-15");
    assert.equal(effectiveDate({ start_date: "2026-05-14" }), "2026-05-14");
    assert.equal(effectiveDate({}), undefined);
  });
});

describe("isEarned", () => {
  it("earned when live and effective date <= today", () => {
    assert.equal(isEarned(row({ start_date: "2026-05-10" }), TODAY), true);
    assert.equal(isEarned(row({ start_date: "2026-05-20" }), TODAY), false);   // future
    assert.equal(isEarned(row({ status: "cancelled", start_date: "2026-05-10" }), TODAY), false);
  });
});

describe("dedupKey priority", () => {
  it("hygglo_order_id > v1_rental_id > composite", () => {
    assert.equal(dedupKey(row({ hygglo_order_id: "123", v1_rental_id: "v1-9" })), "H:123");
    assert.equal(dedupKey(row({ v1_rental_id: "v1-9" })), "V:v1-9");
    const composite = dedupKey(row({
      hygglo_order_id: undefined, v1_rental_id: undefined,
      renter_name: "Alice", account_slug: "dbcinema",
      start_date: "2026-05-20", end_date: "2026-05-22",
    }));
    assert.match(composite, /^F:Alice\|dbcinema\|2026-05-20\|2026-05-22$/);
  });
});

describe("dedupByLogicalRental keeps highest net", () => {
  it("collapses duplicates, retains row with larger net_to_owner_gbp", () => {
    const a = row({ _id: "a", hygglo_order_id: "123", net_to_owner_gbp: 40 });
    const b = row({ _id: "b", hygglo_order_id: "123", net_to_owner_gbp: 80 });
    const out = dedupByLogicalRental([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0]._id, "b");
  });
});

describe("netOf", () => {
  it("returns net_to_owner_gbp or 0", () => {
    assert.equal(netOf(row({ net_to_owner_gbp: 42 })), 42);
    assert.equal(netOf(row({ net_to_owner_gbp: undefined })), 0);
  });
});
