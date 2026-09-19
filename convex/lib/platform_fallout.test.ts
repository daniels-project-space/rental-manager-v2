import { describe, expect, it } from "vitest";
import { countPlatformFallout } from "./platform_fallout";

describe("countPlatformFallout", () => {
  it("counts the authoritative Hygglo renter-cancellation and security-failure events", () => {
    expect(
      countPlatformFallout([
        { status: "cancelled", hygglo_system_signal: "renter_cancelled" },
        { is_obsolete: true, hygglo_system_signal: "verification_failed" },
        { status: "confirmed", hygglo_system_signal: "renter_cancelled" },
      ]),
    ).toEqual({ renter_cancelled_pending_count: 1, failed_security_checks_count: 1 });
  });

  it("uses legacy structural signals only when Hygglo has no decisive signal", () => {
    expect(
      countPlatformFallout([
        {
          status: "cancelled",
          obsolete_reason: "renter_cancelled",
          order_step: "CANCELED",
        },
        {
          is_obsolete: true,
          order_step: "VERIFICATION_FAILED",
        },
        // Legacy polling predates blue-text capture. This is the importer’s
        // canonical verified-stage failure classification and must still count.
        {
          is_obsolete: true,
          obsolete_reason: "verification_failed",
        },
        // A decisive platform signal wins over an inconsistent legacy field.
        {
          is_obsolete: true,
          hygglo_system_signal: "owner_denied",
          obsolete_reason: "verification_failed",
        },
      ]),
    ).toEqual({ renter_cancelled_pending_count: 1, failed_security_checks_count: 2 });
  });
});
