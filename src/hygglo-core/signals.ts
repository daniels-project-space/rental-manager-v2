/**
 * hygglo-core/signals — canonical Hygglo system-signal derivation.
 *
 * SINGLE SOURCE OF TRUTH for `deriveHyggloSystemSignal`. Previously triplicated
 * (poll-hygglo.ts, shape.ts, convex/admin_backfill_hygglo_signals.ts); the three
 * copies were behaviourally identical, so this is a verbatim extraction — no
 * logic change.
 *
 * Phase 3d — derive the most-recent DECISIVE Hygglo system signal ("blue text")
 * from an order's `activities[]`. Iterates in reverse (newest first) and returns
 * the first matching decisive signal. `approved` is NON-decisive: it is only
 * returned when no obsolete-style event followed it (useful downstream for
 * renter_ghosted detection). Returns `none` when nothing matches.
 *
 * Pure: regex over activity.event.content only. No fetch, no I/O. Safe to import
 * from `src/trigger`, `src/hygglo-core`, AND convex modules (it has no
 * `server-only` poison-pill and no framework deps).
 */

export type HyggloSystemSignal =
  | "owner_denied"
  | "renter_cancelled"
  | "auto_cancelled"
  | "verification_failed"
  | "approved"
  | "none";

/**
 * Minimal structural shape this derivation reads. Deliberately permissive so
 * every caller's richer activity type (HyggloActivity, poll-hygglo's `Activity`,
 * the convex backfill's local `Activity`) — and inline test literals carrying
 * `key`/`chatMessage` — are assignable without coupling. The index signature
 * keeps excess-property checks from rejecting those extra fields.
 */
export interface SignalActivity {
  event?: { title?: string; content?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export function deriveHyggloSystemSignal(acts: readonly SignalActivity[]): {
  signal: HyggloSystemSignal;
  text?: string;
} {
  let approvedText: string | undefined;
  for (const a of [...acts].reverse()) {
    const c = a.event?.content ?? "";
    if (!c) continue;
    if (/You have denied the rental request/i.test(c))
      return { signal: "owner_denied", text: c };
    if (/has cancelled the rental request/i.test(c))
      return { signal: "renter_cancelled", text: c };
    if (/Automatically cancelled/i.test(c))
      return { signal: "auto_cancelled", text: c };
    if (
      /did not pass our security checks/i.test(c) ||
      /pre-authorized funds.*cancelled.*rejected/i.test(c)
    )
      return { signal: "verification_failed", text: c };
    if (/Now the borrower should pay/i.test(c) && approvedText === undefined) {
      approvedText = c;
    }
  }
  if (approvedText !== undefined)
    return { signal: "approved", text: approvedText };
  return { signal: "none" };
}
