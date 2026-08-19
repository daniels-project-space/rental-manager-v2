const CONFIRMED_BOOKING_STEPS = new Set([
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
]);

export const MAX_NOTIFICATION_DELIVERY_ATTEMPTS = 3;

export type PushNotificationMode = "all" | "money_only" | "my_share";
export type PushNotificationType =
  | "booking_confirmed"
  | "new_request"
  | "renter_message"
  | "low_response_rate";

export function isGenuinelyConfirmedBooking(
  step: string | null | undefined,
  status: string | null | undefined,
): boolean {
  // A known active step is more precise than Hygglo's broad `current` bucket,
  // whose mapped status can already be "confirmed" while payment is pending.
  if (step) return CONFIRMED_BOOKING_STEPS.has(step);
  return status === "confirmed";
}

export function bookingBecameConfirmed(args: {
  previousStep?: string | null;
  previousStatus?: string | null;
  incomingStep?: string | null;
  incomingStatus?: string | null;
}): boolean {
  return !isGenuinelyConfirmedBooking(args.previousStep, args.previousStatus) &&
    isGenuinelyConfirmedBooking(args.incomingStep, args.incomingStatus);
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function validMoney(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Keep gross paid and owner earnings distinct; never round either to pounds. */
export function formatNotificationAmounts(
  gross: number | undefined,
  net: number | undefined,
  currency = "GBP",
): string {
  if (validMoney(gross) && validMoney(net) && gross !== net) {
    return `${formatCurrency(gross, currency)} paid · ${formatCurrency(net, currency)} earnings`;
  }
  if (validMoney(gross)) return `${formatCurrency(gross, currency)} paid`;
  if (validMoney(net)) return `${formatCurrency(net, currency)} earnings`;
  return "";
}

/**
 * `my_share` renders Daniel's personal cut of the owner earnings. It is a
 * DISPLAY-ONLY scaling applied when the copy is rendered — nothing stored in
 * Convex is halved, so revenue/stats stay the single source of truth.
 */
export const MY_SHARE_FRACTION = 0.5;

/**
 * One-word account labels for the "… on <account>" clause. Accounts are the
 * three Hygglo identities the business rents from; the stored theme labels
 * ("DB Cinema", "Diogo Valdivieso") are too long for a push line.
 */
const ACCOUNT_WORD: Record<string, string> = {
  dbcinema: "Daniel",
  dbcinema_web: "Daniel",
  leo: "Leo",
  diogo: "Diogo",
};

export function accountWord(slug: string | undefined): string {
  if (!slug) return "";
  const known = ACCOUNT_WORD[slug];
  if (known) return known;
  // Unknown/new slug: first segment, capitalised — never a raw snake_case slug.
  const bare = slug.split(/[_-]/)[0];
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "";
}

/** Compact confirmed-booking copy shared by web push, Telegram, and the bell. */
export function buildConfirmedBookingNotificationCopy(args: {
  renterName?: string;
  itemName?: string;
  accountSlug?: string;
  gross?: number;
  net?: number;
  currency?: string;
  /** "my_share" halves the displayed amount; every other mode shows it in full. */
  mode?: PushNotificationMode;
}): { title: string; body: string } {
  const firstName = args.renterName?.trim().split(/\s+/)[0] || "Renter";
  const normalizedItem = (args.itemName?.trim() || "Rental")
    .split("|")[0]
    .replace(/\([^)]*\)/g, " ")
    .split("+")[0]
    .replace(/\s+/g, " ")
    .trim();
  const clippedItem = normalizedItem.length > 42
    ? normalizedItem.slice(0, 42).replace(/\s+\S*$/, "").trimEnd()
    : normalizedItem;
  const itemName = clippedItem || "Rental";
  // Owner earnings (net) is the headline; gross is only a fallback when the
  // poller has not resolved the payout split yet.
  const base = validMoney(args.net)
    ? args.net
    : validMoney(args.gross)
      ? args.gross
      : undefined;
  const scaled = base === undefined
    ? undefined
    : args.mode === "my_share" ? base * MY_SHARE_FRACTION : base;
  const made = validMoney(scaled)
    ? formatCurrency(scaled, args.currency ?? "GBP")
    : "";
  const acct = accountWord(args.accountSlug);
  const where = acct ? `${itemName} on ${acct}` : itemName;
  return {
    title: made ? `🎉 Wohoo, you made ${made}!` : "🎉 Wohoo, booking made!",
    body: `${where} · ${firstName}`,
  };
}

/** Both money modes suppress everything that is not a confirmed booking. */
export function isMoneyOnlyMode(
  mode: PushNotificationMode | undefined,
): boolean {
  return mode === "money_only" || mode === "my_share";
}

/** Money-only is deliberately per subscription so other operators stay on all. */
export function subscriptionReceivesNotification(
  mode: PushNotificationMode | undefined,
  type: PushNotificationType,
): boolean {
  return !isMoneyOnlyMode(mode) || type === "booking_confirmed";
}

/** Daniel's Telegram fallback is money-only unless operations opt it back in. */
export function telegramNotificationMode(
  configuredMode: string | undefined,
): PushNotificationMode {
  if (configuredMode === "all") return "all";
  if (configuredMode === "my_share") return "my_share";
  return "money_only";
}

export function notificationRetryDelayMs(completedAttempts: number): number {
  return completedAttempts <= 1 ? 5 * 60 * 1000 : 30 * 60 * 1000;
}

/**
 * How long a dispatch claim stays valid before another dispatcher may steal it.
 *
 * A claim is normally released within seconds (markDelivered clears it, and the
 * dispatcher releases it explicitly if the send loop throws). The ONLY way a
 * claim outlives its dispatcher is a hard crash / action timeout mid-flight, so
 * this threshold only governs that rare recovery path.
 *
 * Deliberately generous (5 min, matching the first retry backoff): the failure
 * we are fixing is DUPLICATE sends, so re-claiming too eagerly re-creates the
 * exact bug, while re-claiming too late merely delays an already-crashed event.
 * A normal dispatch (a handful of web-push posts + one Telegram fetch) finishes
 * in seconds, so 5 min cannot overlap a still-live dispatcher in practice.
 */
export const NOTIFICATION_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Whether an event may be claimed for sending right now.
 *
 * "Claimed" means some dispatchPending invocation has taken exclusive
 * responsibility for delivering this event. Claim + read happen inside a single
 * Convex mutation, which is a serializable transaction, so two overlapping
 * dispatchers cannot both observe an unclaimed row and both proceed to send.
 */
export function notificationClaimAvailable(
  event: {
    delivered_at?: number;
    dispatch_claimed_at?: number;
  },
  now: number,
): boolean {
  if (event.delivered_at !== undefined) return false;
  if (event.dispatch_claimed_at === undefined) return true;
  return now - event.dispatch_claimed_at >= NOTIFICATION_CLAIM_STALE_MS;
}

export function notificationAttemptDue(
  event: {
    delivery_attempts?: number;
    last_attempt_at?: number;
    delivery_exhausted_at?: number;
  },
  now: number,
): boolean {
  const attempts = event.delivery_attempts ?? 0;
  if (event.delivery_exhausted_at || attempts >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS) return false;
  if (!event.last_attempt_at || attempts === 0) return true;
  return now - event.last_attempt_at >= notificationRetryDelayMs(attempts);
}
