/**
 * Platform/renter fallout counts for the Missed Revenue widget.
 *
 * These are operational outcomes, not money. In particular, a Hygglo renter
 * cancellation or a failed security check must never be added to realised,
 * projected, denied, or missed-revenue £ totals without a separately approved
 * valuation model.
 */

export type PlatformFalloutRow = {
  status?: string | null;
  is_obsolete?: boolean | null;
  denial_actor?: string | null;
  reclassified_outcome?: string | null;
  reclassified_confidence?: string | null;
  obsolete_reason?: string | null;
  order_step?: string | null;
  hygglo_system_signal?: string | null;
  hygglo_system_signal_text?: string | null;
};

export type PlatformFalloutCounts = {
  /** Hygglo says the renter cancelled the rental request while it was pending. */
  renter_cancelled_pending_count: number;
  /** Hygglo's platform event says the renter did not pass its security checks. */
  failed_security_checks_count: number;
};

function isTerminal(row: PlatformFalloutRow): boolean {
  return row.is_obsolete === true || row.status === "cancelled" || row.status === "declined";
}

/**
 * Classify the two explicitly requested non-revenue outcomes. The Hygglo
 * system signal is the source of truth when present. Older rows predate the
 * blue-text signal capture, so `obsolete_reason="verification_failed"` is
 * retained as the importer’s canonical legacy classification: it is written
 * only for a Hygglo-obsolete order that stopped at its verified/funds-reserved
 * verification stage. A conflicting decisive platform signal still wins.
 */
export function countPlatformFallout(rows: readonly PlatformFalloutRow[]): PlatformFalloutCounts {
  let renter_cancelled_pending_count = 0;
  let failed_security_checks_count = 0;

  for (const row of rows) {
    if (!isTerminal(row)) continue;

    const signal = row.hygglo_system_signal;
    const hasDecisiveSignal = signal !== undefined && signal !== null && signal !== "none" && signal !== "approved";

    // Hygglo's exact event wording is "has cancelled the rental request", so
    // this is deliberately the pre-booking/pending-request metric, rather than
    // a completed booking cancellation.
    const renterCancelled = hasDecisiveSignal
      ? signal === "renter_cancelled"
      : (row.reclassified_outcome === "renter_cancelled_explicit" &&
          row.reclassified_confidence === "high") ||
        (row.obsolete_reason === "renter_cancelled" && row.order_step === "CANCELED");

    if (renterCancelled) {
      renter_cancelled_pending_count++;
      continue;
    }

    const failedSecurityCheck = hasDecisiveSignal
      ? signal === "verification_failed"
      : row.order_step === "VERIFICATION_FAILED" ||
        row.obsolete_reason === "verification_failed" ||
        /did not pass our security checks/i.test(row.hygglo_system_signal_text ?? "");

    if (failedSecurityCheck) failed_security_checks_count++;
  }

  return { renter_cancelled_pending_count, failed_security_checks_count };
}
