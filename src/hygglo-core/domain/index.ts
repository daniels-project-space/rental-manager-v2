/**
 * hygglo-core/domain — canonical business constants & predicates.
 *
 * SINGLE SOURCE OF TRUTH. This barrel does NOT define any constants of its
 * own — it merely RE-EXPORTS the canonical definitions that already live in
 * `convex/lib/*` so hygglo-core never forks a second copy of OWNER_SHARE, the
 * London-tz helpers, or the reservation predicates.
 *
 * Why re-export rather than import-and-use directly: it gives the rest of
 * hygglo-core one import surface (`./domain`) for every shared business rule,
 * while keeping the actual logic owned by the existing canonical files. If
 * Daniel changes OWNER_SHARE or the confirmed-with-dates rule, hygglo-core
 * inherits the change automatically with zero edits here.
 *
 * Pure TS, no Convex runtime — these modules are plain functions/constants and
 * are safe to import from Convex V8, Trigger Node, and Next.
 */

// Revenue split (gross → net-to-owner). Canonical: convex/lib/revenue_attribution.ts.
export {
  OWNER_SHARE,
  PLATFORM_FEE_SHARE,
} from "../../../convex/lib/revenue_attribution";

// London-timezone display + "today" helpers. Canonical: convex/lib/effectiveDates.ts.
export {
  londonToday,
  displayPickupDate,
  displayReturnDate,
  displayPickupTime,
  displayReturnTime,
} from "../../../convex/lib/effectiveDates";

// Reservation predicates (live / confirmed-with-dates / ongoing / upcoming …).
// Canonical: convex/lib/reservations/predicates.ts.
export {
  isLive,
  isConfirmedWithDates,
  isOngoing,
  isUpcoming,
  isPendingVerification,
  type ReservationRow,
} from "../../../convex/lib/reservations/predicates";
