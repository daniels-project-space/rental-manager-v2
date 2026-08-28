import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * How often do renters ask for the pickup postcode BEFORE booking?
 *
 * It surfaced as the single most common shape in the uncategorised half of the
 * real inbound corpus — "Hey Leo, hope you are keeping well. Could you please
 * share the postcode and confirm if ..." — and it lands squarely on the one
 * thing the bot must refuse until a booking is confirmed. A high-frequency
 * question we are obliged to decline is worth getting right: handled badly it
 * reads as evasive on first contact, which is exactly when trust is decided.
 *
 * Counts distinct threads too, since one prolific renter repeating a template
 * would mean something very different from many renters asking independently.
 */
export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(6000);
    const renterMsgs = msgs.filter(
      (m) => m.sender === "renter" && !m.thread_id.startsWith("__probe__"),
    );
    const ASK =
      /\b(post ?code|postal code|exact address|full address|where exactly|which area|what area)\b/i;
    const hits = renterMsgs.filter((m) => ASK.test(m.body_text ?? ""));
    const threads = new Set(hits.map((m) => m.thread_id));
    const senders = new Set(hits.map((m) => m.sender_name ?? "?"));

    // Is it the same template repeated, or genuinely different people asking?
    const TEMPLATE = /hope you are keeping well/i;
    const templated = hits.filter((m) => TEMPLATE.test(m.body_text ?? ""));

    return {
      renter_messages_scanned: renterMsgs.length,
      postcode_or_address_asks: hits.length,
      distinct_threads: threads.size,
      distinct_sender_names: senders.size,
      templated_variant: templated.length,
      templated_distinct_threads: new Set(templated.map((m) => m.thread_id)).size,
      samples: hits.slice(0, 6).map((m) => ({
        thread: m.thread_id,
        text: (m.body_text ?? "").replace(/\s+/g, " ").slice(0, 110),
      })),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_postcode_asks.check, {}),
});
