/** Shared event wording. Adapters supply an authoritative final failure and a
 * basket referral; renter prose cannot cause cancellation or verification. */
export const FRIEND_BOOKING_NEXT_STEPS = "This is your own new request, not a confirmed booking. Please submit it from your account and complete the platform's approval, payment and verification steps. Your friend's approval, payment and verification don't transfer, even if your account was verified before.";

export function verificationFailureReply(code: string) {
  return `Unfortunately, verification wasn't approved, so this booking was automatically cancelled. If you have a verified friend who can take responsibility for the rental, they can make a new request from their own account. Ask them to mention that you sent them and share basket reference ${code}; we'll recognise it and check the same equipment's current availability and price for them. Their request still needs its own checks, even if they were verified before. We can also look for suitable lower-value equipment, which may help with approval, although approval isn't guaranteed. Please don't share account login details.`;
}

/** Require an explicit referral and one opaque code; names never link renters. */
export function friendReferralFromMessage(text: string): string | null {
  const codes=friendReferralCodesFromMessage(text);
  return codes.length === 1 ? codes[0].toLowerCase() : null;
}

/** Preserve ambiguity instead of silently falling back to an older code. */
export function friendReferralCodesFromMessage(text:string):string[] {
 const existingReferralSignal=/\b(?:friends?|sent me|referrals?|same basket)\b/i.test(text);
 const naturalReferralSignal=/\breferred\b/i.test(text)&&/\bbasket references?\b/i.test(text);
 if(!existingReferralSignal&&!naturalReferralSignal)return [];
 return [...new Set((text.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi)??[]).map(c=>c.toLowerCase()))];
}

/** Recognition is not consent. A write requires a current direct instruction;
 * questions, hypothetical instructions and copied examples remain read-only. */
export function requestsFriendBasketRestore(text:string) {
  const message=text.replace(/[’‘]/g,"'").replace(/```[\s\S]*?```/g," ").replace(/["“][^"”]*["”]/g," ");
  return message.split(/[;\n]|(?<=[.!?])\s+/).some(clause=>{
    if(/\b(?:maybe|might|consider|thinking|suppose|example|said|says|told|don't|do not|never|wait|hold off|after I confirm|before I confirm)\b/i.test(clause))return false;
    const directAction=/(?:^|\b(?:please|go ahead(?: and)?|(?:can|could|would) you|I(?:'d| would) like (?:you )?to|and|then)\s+)(?:restore|rebuild|add|use|copy)\s+/i.test(clause);
    const explicitBasket=/\b(?:basket|gear|equipment|items?|setup)\b/i.test(clause);
    const explicitNamedGear=/\b(?:kit|camera|lenses?)\b/i.test(clause);
    const explicitOwnTargetWithPronoun=/\b(?:restore|rebuild|add|use|copy)\s+(?:it|them)\b[\s\S]*\b(?:to|into)\s+my(?:\s+(?:own|new))*\s+(?:basket|request|inquiry)\b/i.test(clause);
    if(!directAction||!(explicitBasket||explicitNamedGear||explicitOwnTargetWithPronoun))return false;
    // A request such as “check it and add it to my request if available” is
    // explicit conditional consent. Other hypothetical/conditional wording
    // remains read-only, and multiple conditions are too ambiguous to write.
    const conditions=[...clause.matchAll(/\b(?:if|when)\b/gi)];
    if(conditions.length){
      if(conditions.length!==1||!/(?:if|when)\s+(?:(?:it|this|that)\s+)?(?:is\s+)?available\b/i.test(clause))return false;
    }
    return true;
  });
}

export function friendBasketReply(order: { start_date: string | null; end_date: string | null; total_gbp: number | null; lines: { name: string; qty: number }[] }, preview=false) {
  const action=preview ? "Here is the basket preview with current prices and availability" : "I've restored the basket for your own new request after checking current prices and availability";
  return `Your friend's basket referral was recognised. ${action} for ${order.start_date} to ${order.end_date}.${preview?" No items or dates were added or changed, and the referral hasn't been used.":""}\n\nBasket:\n${order.lines.map(line => `${line.qty}× ${line.name}`).join("\n")}\n\nCurrent rental total: £${order.total_gbp}. ${FRIEND_BOOKING_NEXT_STEPS}`;
}
