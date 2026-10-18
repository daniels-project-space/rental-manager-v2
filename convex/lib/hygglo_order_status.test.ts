import { describe, expect, it } from "vitest";
import { deriveStatusFromStep, obsoleteReasonForOrder, shouldRetainTerminalOrderStep } from "./hygglo_order_status";

describe("Hygglo import status", () => {
  it("keeps terminal provider steps terminal even when returned in pending", () => {
    expect(deriveStatusFromStep("VERIFICATION_FAILED", "pending")).toBe("cancelled");
    expect(deriveStatusFromStep("CANCELED", "pending")).toBe("cancelled");
    expect(obsoleteReasonForOrder("VERIFICATION_FAILED", "pending")).toBe("verification_failed");
    expect(obsoleteReasonForOrder("CANCELED", "pending")).toBe("renter_cancelled");
  });

  it("preserves the existing filter behavior for nonterminal steps", () => {
    expect(deriveStatusFromStep("FUNDS_RESERVED", "pending")).toBe("pending_review");
    expect(deriveStatusFromStep("VERIFIED", "pending")).toBe("pending_review");
    expect(deriveStatusFromStep("RETURNED", "current")).toBe("confirmed");
    expect(deriveStatusFromStep("REVIEWED", "current")).toBe("completed");
    expect(deriveStatusFromStep("REVIEWED", "obsolete")).toBe("cancelled");
  });

  it("retains the provider obsolete-bucket legacy classification", () => {
    expect(obsoleteReasonForOrder("REQUEST", "obsolete")).toBe("owner_denied");
    expect(obsoleteReasonForOrder("FUNDS_RESERVED", "obsolete")).toBe("verification_failed");
    expect(obsoleteReasonForOrder("APPROVED", "current")).toBeNull();
  });

  it("does not reopen a terminal order when a later poll regresses its step", () => {
    expect(shouldRetainTerminalOrderStep("VERIFICATION_FAILED", "APPROVED")).toBe(true);
    expect(shouldRetainTerminalOrderStep("CANCELED", "REQUEST")).toBe(true);
    expect(shouldRetainTerminalOrderStep("REVIEWED", "RETURNED")).toBe(true);
    expect(shouldRetainTerminalOrderStep("VERIFICATION_FAILED", "CANCELED")).toBe(false);
    expect(shouldRetainTerminalOrderStep("APPROVED", "VERIFIED")).toBe(false);
  });
});
