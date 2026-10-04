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

export function friendReferralCode(messages:ReadonlyArray<{sender:string;body_text:string}>) {
  const latest=messages.at(-1),current=latest?.sender==="renter"?friendReferralFromMessage(latest.body_text):null;
  const codes=[...new Set(messages.filter(m=>m.sender==="renter").map(m=>friendReferralFromMessage(m.body_text)).filter((c):c is string=>!!c))];
  return {code:current??(codes.length===1?codes[0]:null),ambiguous:!current&&codes.length>1};
}

/** Recognition is not consent. A write requires a current direct instruction;
 * questions, hypothetical instructions and copied examples remain read-only. */
export function requestsFriendBasketRestore(text:string) {
  const message=text.replace(/[’‘]/g,"'").replace(/```[\s\S]*?```/g," ").replace(/["“][^"”]*["”]/g," ");
  return message.split(/[;\n]|(?<=[.!?])\s+/).some(clause=>{
    if(/\b(?:if|maybe|might|consider|thinking|suppose|example|said|says|told|don't|do not|never|wait|hold off|after I confirm|before I confirm)\b/i.test(clause))return false;
    return /(?:^|\b(?:please|go ahead(?: and)?|(?:can|could|would) you|I(?:'d| would) like (?:you )?to)\s+)(?:restore|rebuild|add|use|copy)\s+(?:the\s+|my\s+|their\s+|that\s+|this\s+|same\s+|friend's\s+)*(?:basket|gear|equipment|items?|setup)\b/i.test(clause);
  });
}

export function friendBasketReply(order: { start_date: string | null; end_date: string | null; total_gbp: number | null; lines: { name: string; qty: number }[] }, preview=false) {
  const action=preview ? "Here is the basket preview with current prices and availability" : "I've restored the basket for your own new request after checking current prices and availability";
  return `Your friend's basket referral was recognised. ${action} for ${order.start_date} to ${order.end_date}.${preview?" No items or dates were added or changed, and the referral hasn't been used.":""}\n\nBasket:\n${order.lines.map(line => `${line.qty}× ${line.name}`).join("\n")}\n\nCurrent rental total: £${order.total_gbp}. This is a new request, not a confirmed booking. Please book from your own account and complete the platform's approval, payment and verification steps. Previous approval, payment and verification don't transfer, even if your account was verified before.`;
}
