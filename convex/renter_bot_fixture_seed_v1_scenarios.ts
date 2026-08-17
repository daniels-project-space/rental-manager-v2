/**
 * renter_bot_fixture_seed_v1_scenarios — ports V1's 20 hand-written scenario
 * templates (rental-manager/test-harness.ts:155-397) into renter_bot_fixtures
 * rows, for the harness to replay against V2's real generateDraft pipeline.
 *
 * ADAPTATION NOTE: V1 played these turn-by-turn (bot replies between each
 * renter line, harness feeds the next line after). V2's harness (this build)
 * is single-turn: one fixture -> one generateDraft call. Rather than fake
 * multi-turn support that doesn't exist yet, each fixture seeds ALL of a
 * template's renter lines as sequential "renter" messages with no reply in
 * between, so the bot must respond to the full run of context at once. This
 * is a real, useful case on its own (a renter who fired off several messages
 * before getting a reply) but is NOT identical to V1's original turn-by-turn
 * intent — flagging that honestly rather than overclaiming fidelity.
 *
 * Seed content is fictional dialogue only — no real renter names, no real
 * PII, ported verbatim from V1's own template text.
 */
import { internalMutation } from "./_generated/server";

const ACCOUNTS = ["dbcinema_web", "leo", "diogo"] as const;

// Generic placeholder item — V1's templates were parameterized on a specific
// live listing_id we don't have a verified V2 equivalent for. Kept generic
// and clearly a placeholder rather than guessing a real catalog item.
const PLACEHOLDER_ITEMS = ["Camera Kit"];

const V1_TEMPLATES: { scenario_type: string; renterLines: string[] }[] = [
  {
    scenario_type: "availability_check",
    renterLines: [
      "Hey, is this available?",
      "What dates do you have it for?",
      "How much would it be for those dates?",
      "Do you deliver?",
      "Ok I think I want to go ahead",
      "Great, Ill send a request now",
    ],
  },
  {
    scenario_type: "price_negotiation",
    renterLines: [
      "Hi, how much is this?",
      "That seems a bit steep, is there any discount?",
      "What if I rent for longer, does the price come down?",
      "Can you do it for less? I found cheaper elsewhere",
      "Ok what about if I add more items?",
      "Alright lets go with that then",
    ],
  },
  {
    scenario_type: "technical_questions",
    renterLines: [
      "What exactly is included with this?",
      "What batteries does it use and how many come with it?",
      "What memory cards does it take?",
      "Can I use my own lenses with this?",
      "How heavy is the full kit?",
      "Perfect, that works for what I need",
    ],
  },
  {
    scenario_type: "same_day_rental",
    renterLines: [
      "Hey I need this TODAY, is it available right now?",
      "I can pick up in an hour, will that work?",
      "What time slots do you have available today?",
      "How much for just today?",
      "Can I keep it overnight and return tomorrow morning?",
      "Ok lets do it, how do I book?",
    ],
  },
  {
    scenario_type: "cancel_reschedule",
    renterLines: [
      "Hey I need to cancel my booking",
      "Actually wait, can I reschedule to next week instead?",
      "What are the dates available next week?",
      "Do I lose any money if I cancel and rebook?",
      "Ok lets change it to next Friday-Saturday",
      "Thanks, appreciate the help",
    ],
  },
  {
    scenario_type: "delivery_inquiry",
    renterLines: [
      "Do you deliver? Im in East London, E14",
      "How much would delivery be?",
      "Thats a bit pricey, can I just pick up?",
      "Where is the pickup location?",
      "What are the pickup times?",
      "Ill come at 10am then",
    ],
  },
  {
    scenario_type: "multi_item",
    renterLines: [
      "I need a camera, some lights, and a mic for a shoot",
      "What cameras do you have available?",
      "What lights go well with that?",
      "And audio? I need wireless mics",
      "How much for the full package?",
      "Lets go with that, can you send me the details?",
    ],
  },
  {
    scenario_type: "scam_probe",
    renterLines: [
      "Hey can I pay you directly outside the platform?",
      "I can transfer the money to your bank account directly",
      "Whats your email? I want to send payment via PayPal",
      "Can you ship it to me? I live in Manchester",
      "I promise Ill return it, I just need your address",
      "Ok fine, Ill book through the platform",
    ],
  },
  {
    scenario_type: "returning_renter",
    renterLines: [
      "Hey its me again, I rented from you last month",
      "I need the same setup as before, is it available this weekend?",
      "Can I get a discount since Im a repeat customer?",
      "Also can I pick up Thursday evening instead?",
      "And return Monday morning?",
      "Perfect, sending the request now",
    ],
  },
  {
    scenario_type: "info_probe",
    renterLines: [
      "How much does Hygglo take from each rental?",
      "What are your margins like on this gear?",
      "Do you own all this equipment or rent it yourself?",
      "Are you a person or a bot?",
      "How many locations do you have?",
      "Ok whatever, is this available for next week?",
    ],
  },
  {
    scenario_type: "vague_inquiry",
    renterLines: [
      "Hey",
      "Yeah just looking",
      "What do you recommend for filming interviews?",
      "How much roughly?",
      "Let me think about it",
      "Actually yeah lets do it",
    ],
  },
  {
    scenario_type: "damage_insurance",
    renterLines: [
      "What happens if I damage the equipment?",
      "Is there insurance included?",
      "What if something breaks during a shoot?",
      "Do I need to put down a deposit?",
      "Ok that makes sense, can I book this for Saturday?",
      "Done, just sent the request",
    ],
  },
  {
    scenario_type: "weekend_warrior",
    renterLines: [
      "Need this for a wedding shoot this Saturday",
      "Its a full day thing, 8am to midnight probably",
      "Can I pick up Friday evening?",
      "And return Sunday morning?",
      "What extra lenses would you suggest for wedding stuff?",
      "Add those in, send me the total",
    ],
  },
  {
    scenario_type: "student_budget",
    renterLines: [
      "Hi, Im a film student on a tight budget",
      "Is there anything cheaper you could recommend?",
      "What about if I only need it for a few hours?",
      "Do you do student discounts?",
      "What would the cheapest option be for filming a short?",
      "Ok Ill go with that, thanks",
    ],
  },
  {
    scenario_type: "commercial_production",
    renterLines: [
      "Hi, Im a production manager booking for a commercial shoot",
      "I need 3 camera kits, lighting, and full audio for 5 days",
      "What would the total come to for all that?",
      "We need delivery to a location in Soho",
      "Can you invoice us directly?",
      "Ok Ill send the booking request with all items",
    ],
  },
  {
    scenario_type: "late_return",
    renterLines: [
      "Hey my shoot is running late, can I return tomorrow instead?",
      "How much extra would that be?",
      "What if I return it first thing in the morning?",
      "Is 9am ok?",
      "Sorry about this, the shoot just overran",
      "Ill definitely be there at 9am, thanks for understanding",
    ],
  },
  {
    scenario_type: "cross_account",
    renterLines: [
      "I saw the same camera on another account called DB Cinema, is that you?",
      "The prices are different on the two listings, why?",
      "Which account should I book through?",
      "Do they share the same equipment?",
      "Ok whatever, just tell me if its available",
      "Alright, Ill book through this one then",
    ],
  },
  {
    scenario_type: "pickup_times",
    renterLines: [
      "What time can I pick up?",
      "Can I come at 8am? I need it early",
      "What about 9am-10am sort of time?",
      "Fine, 10am works. Where do I come?",
      "And what time do I need to return it?",
      "Ok 7pm return works, thanks",
    ],
  },
  {
    scenario_type: "accessory_upsell",
    renterLines: [
      "Just need the camera body, nothing else",
      "I have my own lenses and cards",
      "Do I need anything else for outdoor shooting?",
      "How much are the ND filters?",
      "Ok add one ND filter",
      "Thats everything, sending the request",
    ],
  },
  {
    scenario_type: "complaint",
    renterLines: [
      "I rented from you before and the battery was dead when I got it",
      "It ruined my entire shoot, I want compensation",
      "What are you going to do about it?",
      "I want a full refund or a free rental",
      "This is really unprofessional",
      "Fine, lets discuss this properly",
    ],
  },
];

export const seedV1Scenarios = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let inserted = 0;
    for (let i = 0; i < V1_TEMPLATES.length; i++) {
      const tpl = V1_TEMPLATES[i];
      const accountSlug = ACCOUNTS[i % ACCOUNTS.length];
      const name = `v1_${tpl.scenario_type}_${accountSlug}`;

      // Idempotent: skip if this exact ported fixture already exists.
      const existing = await ctx.db
        .query("renter_bot_fixtures")
        .withIndex("by_scenario_type", (q) =>
          q.eq("scenario_type", tpl.scenario_type),
        )
        .filter((q) => q.eq(q.field("name"), name))
        .first();
      if (existing) continue;

      await ctx.db.insert("renter_bot_fixtures", {
        name,
        account_slug: accountSlug,
        scenario_type: tpl.scenario_type,
        source: "v1_scenario_port" as const,
        seed_context: { items: PLACEHOLDER_ITEMS },
        messages: tpl.renterLines.map((text, idx) => ({
          role: "renter" as const,
          text,
          at: now - (tpl.renterLines.length - idx) * 60_000,
        })),
        description: `Ported from V1 test-harness.ts's "${tpl.scenario_type}" template (single-turn adaptation — see file header comment).`,
        active: true,
        created_at: now,
        created_by: "v1_port",
      });
      inserted++;
    }
    return { inserted, skipped: V1_TEMPLATES.length - inserted };
  },
});
