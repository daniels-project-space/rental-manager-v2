/** Shared event wording. Adapters supply an authoritative final failure and a
 * basket referral; renter prose cannot cause cancellation or verification. */
export function verificationFailureReply(code: string) {
  return `Hygglo couldn't approve verification, so this booking has been cancelled. If you'd like, a friend can make a new booking from their own account and take responsibility for the rental. Ask them to say you sent them and share basket referral ${code}. We'll recognise the referral and check the basket's current availability and price for them. Their booking still needs Hygglo's own checks, even if their account was verified before. You can also ask us to check suitable lower-value equipment; this may change the verification requirements, but approval isn't guaranteed. Please don't share account login details.`;
}

/** Require an explicit referral and one opaque code; names never link renters. */
export function friendReferralFromMessage(text: string): string | null {
  if (!/\b(?:friend|sent me|referral|same basket)\b/i.test(text)) return null;
  const codes = text.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi) ?? [];
  return codes.length === 1 ? codes[0].toLowerCase() : null;
}

export function friendBasketReply(order: { start_date: string | null; end_date: string | null; total_gbp: number | null; lines: { name: string; qty: number }[] }) {
  return `Your friend's basket referral was recognised. I've restored the basket for your own new request after checking current prices and availability for ${order.start_date} to ${order.end_date}.\n\nBasket:\n${order.lines.map(line => `${line.qty}× ${line.name}`).join("\n")}\n\nCurrent rental total: £${order.total_gbp}. This is a new request, not a confirmed booking. Please book from your own account and complete the platform's approval, payment and verification steps. Previous approval, payment and verification don't transfer, even if your account was verified before.`;
}
