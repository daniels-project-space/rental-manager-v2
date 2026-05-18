/**
 * Unit tests for the denial classifier.
 * Source matrix: /tmp/audit_reclassification.md §1 (41 rows).
 *
 * Coverage strategy: at least one fixture per matrix sub-section (1A-1E)
 * plus chat-regex precedence tests. 12 fixtures total.
 */

import { describe, expect, it } from "vitest";
import {
  classifyDenialActor,
  OWNER_CANCEL_RE,
  RENTER_CANCEL_RE,
  OWNER_APPROVAL_RE,
  type ClassifierInput,
} from "./denial_classifier";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

function input(o: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    obsolete_at: NOW,
    last_message_at: NOW - 5 * DAY_MS,
    ...o,
  };
}

describe("classifyDenialActor", () => {
  // ── Chat regex precedence (audit §2D) ────────────────────────────────
  it("F0a chat owner_cancel hit → owner_denied high regardless of structural cell", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "renter_cancelled",
      gross_paid_gbp: 50,
      last_message_sender: "me",
      chat_owner_cancel_hit: true,
    }));
    expect(out.outcome).toBe("owner_denied");
    expect(out.confidence).toBe("high");
    expect(out.signal).toContain("chat:owner_cancel_re");
  });

  it("F0b chat renter_cancel hit → renter_cancelled_explicit high", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "other",
      gross_paid_gbp: 0,
      last_message_sender: "renter",
      chat_renter_cancel_hit: true,
    }));
    expect(out.outcome).toBe("renter_cancelled_explicit");
    expect(out.confidence).toBe("high");
  });

  // ── 1A. obsolete_reason = owner_denied ───────────────────────────────
  it("F1 row 1-3: owner_denied + paid=0 + last_msg=me → owner_denied high", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "owner_denied",
      gross_paid_gbp: 0,
      last_message_sender: "me",
    }));
    expect(out.outcome).toBe("owner_denied");
    expect(out.confidence).toBe("high");
  });

  it("F2 row 4-6: owner_denied + paid=0 + last_msg=renter → renter_ghosted", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "owner_denied",
      gross_paid_gbp: 0,
      last_message_sender: "renter",
    }));
    expect(out.outcome).toBe("renter_ghosted");
  });

  // ── 1B. obsolete_reason = renter_cancelled ───────────────────────────
  it("F3 row 9-11: renter_cancelled + paid>0 + days>=3 + sender=renter → renter_cancelled_explicit high", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "renter_cancelled",
      gross_paid_gbp: 75,
      last_message_sender: "renter",
      last_message_at: NOW - 10 * DAY_MS,
    }));
    expect(out.outcome).toBe("renter_cancelled_explicit");
    expect(out.confidence).toBe("high");
  });

  it("F4 row 19: renter_cancelled + paid=0 + sender=me → renter_ghosted high (ghosted after owner action)", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "renter_cancelled",
      gross_paid_gbp: 0,
      last_message_sender: "me",
      last_message_at: NOW - 8 * DAY_MS,
    }));
    expect(out.outcome).toBe("renter_ghosted");
    expect(out.confidence).toBe("high");
  });

  // ── 1C. obsolete_reason = verification_failed ────────────────────────
  it("F5 row 23-25: verification_failed → system_or_other high", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "verification_failed",
      gross_paid_gbp: 50,
      last_message_sender: "renter",
    }));
    expect(out.outcome).toBe("system_or_other");
    expect(out.confidence).toBe("high");
  });

  it("F6 row 26-28: verification_failed + FUNDS_RESERVED + paid=0 → renter_ghosted high", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "verification_failed",
      order_step: "FUNDS_RESERVED",
      gross_paid_gbp: 0,
      last_message_sender: "me",
    }));
    expect(out.outcome).toBe("renter_ghosted");
    expect(out.confidence).toBe("high");
  });

  // ── 1D. obsolete_reason = other ──────────────────────────────────────
  it("F7 row 34-38: other + APPROVED + paid=0 → renter_ghosted (textbook ghost-after-approval)", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "other",
      order_step: "APPROVED",
      gross_paid_gbp: 0,
      last_message_sender: "me",
    }));
    expect(out.outcome).toBe("renter_ghosted");
  });

  it("F8 null-step prod reality: other + paid=0 + sender=me + days>=7 → renter_ghosted medium", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "other",
      order_step: null,
      gross_paid_gbp: 0,
      last_message_sender: "me",
      last_message_at: NOW - 14 * DAY_MS,
    }));
    expect(out.outcome).toBe("renter_ghosted");
    expect(out.confidence).toBe("medium");
  });

  // ── 1E. obsolete_reason undefined ────────────────────────────────────
  it("F9 row 41: no obsolete_reason → system_or_other low", () => {
    const out = classifyDenialActor(input({}));
    expect(out.outcome).toBe("system_or_other");
    expect(out.confidence).toBe("low");
  });

  it("F10 no reason + paid=0 + sender=me → renter_ghosted low (fallback)", () => {
    const out = classifyDenialActor(input({
      gross_paid_gbp: 0,
      last_message_sender: "me",
    }));
    expect(out.outcome).toBe("renter_ghosted");
    expect(out.confidence).toBe("low");
  });

  // ── Default fallback ─────────────────────────────────────────────────
  it("F11 unknown reason value → system_or_other low", () => {
    const out = classifyDenialActor(input({
      obsolete_reason: "weird_unmapped_value",
      gross_paid_gbp: 100,
      last_message_sender: "renter",
    }));
    expect(out.outcome).toBe("system_or_other");
  });
});

describe("chat regex patterns", () => {
  it("OWNER_CANCEL_RE catches Daniel's typical cancel phrases", () => {
    expect(OWNER_CANCEL_RE.test("Sorry, I can't do those dates")).toBe(true);
    expect(OWNER_CANCEL_RE.test("Already booked I'm afraid")).toBe(true);
    expect(OWNER_CANCEL_RE.test("Unable to deliver, gear is broken")).toBe(true);
    expect(OWNER_CANCEL_RE.test("Hi, when did you want to pick up?")).toBe(false);
  });

  it("RENTER_CANCEL_RE catches typical renter cancel phrases", () => {
    expect(RENTER_CANCEL_RE.test("I don't need it anymore, sorry")).toBe(true);
    expect(RENTER_CANCEL_RE.test("Changed my mind, can I get a refund?")).toBe(true);
    expect(RENTER_CANCEL_RE.test("Found another cheaper option")).toBe(true);
    expect(RENTER_CANCEL_RE.test("Looking forward to pickup tomorrow")).toBe(false);
  });

  it("OWNER_APPROVAL_RE catches approval phrases", () => {
    expect(OWNER_APPROVAL_RE.test("Approved, go ahead")).toBe(true);
    expect(OWNER_APPROVAL_RE.test("Sounds good, see you Friday")).toBe(true);
    expect(OWNER_APPROVAL_RE.test("Could you confirm the pickup time?")).toBe(false);
  });
});
