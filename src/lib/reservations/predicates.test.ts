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
  isOverdue,
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
  it("STAYS ongoing once end_date has passed while the renter still has the gear", () => {
    // Reversed 2026-09-02. The old rule dropped past-end rentals from Active,
    // so the dashboard read "0 ongoing" while the Return Hub listed four
    // rentals overdue since 22–31 Aug — gear physically out, invisible on the
    // dashboard. completeStaleConfirmedCron deliberately will NOT auto-complete
    // these steps, so they sit at status="confirmed" until the owner ticks the
    // return on Hygglo. They are overdue, not finished.
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "RETURNED" }), TODAY), true);
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "DELIVERED" }), TODAY), true);
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "BOOKED_AFTER_VERIFIED" }), TODAY), true);
  });
  it("does NOT keep past-end rentals ongoing when the gear is not out", () => {
    // Any other step means the kit is not with the renter; completeStaleConfirmedCron
    // demotes these to "completed" within a day, so they must not linger in Active.
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "REVIEWED" }), TODAY), false);
    assert.equal(isOngoing(row({ start_date: "2026-04-01", end_date: "2026-05-13" }), TODAY), false);
  });
  it("isOverdue marks exactly the past-end rentals whose gear is still out", () => {
    assert.equal(isOverdue(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "RETURNED" }), TODAY), true);
    // In-window rentals are ongoing but not overdue.
    assert.equal(isOverdue(row({ start_date: "2026-05-14", end_date: "2026-05-22", order_step: "RETURNED" }), TODAY), false);
    assert.equal(isOverdue(row({ start_date: "2026-04-01", end_date: "2026-05-13", order_step: "REVIEWED" }), TODAY), false);
  });
  it("upcoming when start > today", () => {
    assert.equal(isUpcoming(row({ start_date: "2026-05-20" }), TODAY), true);
    assert.equal(isUpcoming(row({ start_date: "2026-05-14" }), TODAY), false);
  });
  it("does NOT use order_step to gate ongoing/upcoming — confirmed rows show regardless of step", () => {
    // 2026-06-02 regression fix: the previous build added !isPendingVerification
    // to isOngoing/isUpcoming, which deleted legitimate CONFIRMED upcoming/ongoing
    // rentals that transiently sit at order_step VERIFIED / BOOKED_AFTER_VERIFIED
    // between payment and handover. A genuine pending-verification item is
    // status="pending_review" (NOT "confirmed"), so it is already excluded by
    // isConfirmedWithDates — order_step must not be a second gate here.
    // Real data (hearty-oyster-600, 2026-06-02): every order_step=VERIFIED row is
    // status="pending_review"; confirmed bookings live at DELIVERED/RETURNED and
    // pass through VERIFIED only transiently. So a confirmed VERIFIED row IS active.
    const verifiedOngoingShape = row({ start_date: "2026-05-14", end_date: "2026-05-22", order_step: "VERIFIED" });
    const verifiedUpcomingShape = row({ start_date: "2026-05-20", end_date: "2026-05-22", order_step: "VERIFIED" });
    assert.equal(isOngoing(verifiedOngoingShape, TODAY), true);
    assert.equal(isUpcoming(verifiedUpcomingShape, TODAY), true);
    // Other steps classify identically (step is irrelevant to active membership).
    assert.equal(isOngoing(row({ start_date: "2026-05-14", end_date: "2026-05-22", order_step: "DELIVERED" }), TODAY), true);
    assert.equal(isUpcoming(row({ start_date: "2026-05-20", end_date: "2026-05-22", order_step: "BOOKED_AFTER_VERIFIED" }), TODAY), true);
    // A TRUE pending-verification row (status=pending_review) is still hidden from
    // active by isConfirmedWithDates, and is still flagged pending.
    const truePending = row({ status: "pending_review", start_date: "2026-05-20", end_date: "2026-05-22", order_step: "VERIFIED" });
    assert.equal(isUpcoming(truePending, TODAY), false);
    assert.equal(isOngoing(row({ status: "pending_review", start_date: "2026-05-14", end_date: "2026-05-22", order_step: "VERIFIED" }), TODAY), false);
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
