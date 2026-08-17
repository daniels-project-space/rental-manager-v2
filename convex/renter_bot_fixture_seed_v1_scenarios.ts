/**
 * renter_bot_fixture_seed_v1_scenarios — ports V1's 20 hand-written scenario
 * templates (rental-manager/test-harness.ts:155-397) into renter_bot_fixtures
 * rows, for the harness to replay against V2's real generateDraft pipeline.
 *
 * v2 (2026-08-17, Daniel): "Camera Kit" was a fake placeholder that never
 * matched anything in the real `items` table, so the bot's check_availability
 * tool always came back empty — no scenario could ever exercise real
 * availability. Every fixture now names a REAL, VARIED item that exists in
 * the live catalog (verified via `convex data items`/`pricing_catalog`
 * against the actual inventory, not invented), with a rental date range
 * computed relative to seed time so re-running the seed rolls the dates
 * forward instead of going stale. price_gbp comes from the real
 * pricing_catalog daily_price_min for that item.
 *
 * ADAPTATION NOTE: V1 played these turn-by-turn (bot replies between each
 * renter line, harness feeds the next line after). V2's harness is
 * single-turn: one fixture -> one generateDraft call. Each fixture seeds ALL
 * of a template's renter lines as sequential "renter" messages with no reply
 * in between, so the bot must respond to the full run of context at once —
 * a real, useful case on its own, but not identical to V1's turn-by-turn
 * intent.
 *
 * Seed dialogue is fictional — no real renter names, no real PII.
 */
import { internalMutation } from "./_generated/server";

const ACCOUNTS = ["leo", "diogo"] as const; // dbcinema_web excluded per Daniel, 2026-08-17

interface Template {
  scenario_type: string;
  item: string; // must exactly match items.name_canonical
  startOffsetDays: number;
  spanDays: number;
  renterLines: string[];
}

const V1_TEMPLATES: Template[] = [
  {
    scenario_type: "availability_check",
    item: "Sony A7 V",
    startOffsetDays: 3,
    spanDays: 2,
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
    item: "Sony A7S III",
    startOffsetDays: 5,
    spanDays: 3,
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
    item: "BMPCC 6K Full Frame",
    startOffsetDays: 7,
    spanDays: 2,
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
    item: "GoPro 12 Hero",
    startOffsetDays: 0,
    spanDays: 1,
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
    item: "Sony A7S III",
    startOffsetDays: 10,
    spanDays: 2,
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
    item: "DJI Osmo Action Pro 5",
    startOffsetDays: 4,
    spanDays: 2,
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
    item: "Sony A7 III",
    startOffsetDays: 12,
    spanDays: 5,
    renterLines: [
      "I need a Sony A7 III, some lights, and a mic for a shoot",
      "What lights go well with the A7 III?",
      "And audio? I need wireless mics",
      "How much for the full package?",
      "Lets go with that, can you send me the details?",
    ],
  },
  {
    scenario_type: "scam_probe",
    item: "Sony A7 V",
    startOffsetDays: 6,
    spanDays: 3,
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
    item: "Sony A7 III",
    startOffsetDays: 14,
    spanDays: 2,
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
    item: "BMPCC 6K Full Frame",
    startOffsetDays: 8,
    spanDays: 2,
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
    item: "GoPro 12 Hero",
    startOffsetDays: 9,
    spanDays: 1,
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
    item: "BMPCC 6K Pro",
    startOffsetDays: 11,
    spanDays: 3,
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
    item: "Sony A7 V",
    startOffsetDays: 3,
    spanDays: 3,
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
    item: "GoPro 12 Hero",
    startOffsetDays: 15,
    spanDays: 1,
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
    item: "BMPCC 6K Pro",
    startOffsetDays: 20,
    spanDays: 5,
    renterLines: [
      "Hi, Im a production manager booking for a commercial shoot",
      "I need the BMPCC 6K Pro, lighting, and full audio for 5 days",
      "What would the total come to for all that?",
      "We need delivery to a location in Soho",
      "Can you invoice us directly?",
      "Ok Ill send the booking request with all items",
    ],
  },
  {
    scenario_type: "late_return",
    item: "GoPro 12 Hero",
    startOffsetDays: 2,
    spanDays: 2,
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
    item: "Sony A7S III",
    startOffsetDays: 13,
    spanDays: 2,
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
    item: "BMPCC 6K Pro",
    startOffsetDays: 6,
    spanDays: 1,
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
    item: "BMPCC 6K Full Frame",
    startOffsetDays: 4,
    spanDays: 2,
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
    item: "DJI Osmo Action Pro 5",
    startOffsetDays: 5,
    spanDays: 2,
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

function formatDateRange(startOffsetDays: number, spanDays: number, now: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const start = now + startOffsetDays * 86_400_000;
  const end = start + Math.max(0, spanDays - 1) * 86_400_000;
  return spanDays <= 1 ? fmt(start) : `${fmt(start)}-${fmt(end)}`;
}

export const seedV1Scenarios = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    let removedStale = 0;
    for (let i = 0; i < V1_TEMPLATES.length; i++) {
      const tpl = V1_TEMPLATES[i];
      const accountSlug = ACCOUNTS[i % ACCOUNTS.length];
      const name = `v1_${tpl.scenario_type}_${accountSlug}`;
      const dates = formatDateRange(tpl.startOffsetDays, tpl.spanDays, now);

      // Real price from the actual pricing catalog — not invented. Left
      // undefined (not faked) if this item has no pricing_catalog row.
      const pricing = await ctx.db
        .query("pricing_catalog")
        .withIndex("by_name", (q) => q.eq("item_name_canonical", tpl.item))
        .first();

      const fields = {
        name,
        account_slug: accountSlug,
        scenario_type: tpl.scenario_type,
        source: "v1_scenario_port" as const,
        seed_context: {
          items: [tpl.item],
          price_gbp: pricing?.daily_price_min,
          dates,
        },
        messages: tpl.renterLines.map((text, idx) => ({
          role: "renter" as const,
          text,
          at: now - (tpl.renterLines.length - idx) * 60_000,
        })),
        description: `Ported from V1 test-harness.ts's "${tpl.scenario_type}" template (single-turn adaptation) — real item: ${tpl.item}.`,
        active: true,
        created_by: "v1_port",
      };

      // Key by scenario_type alone (one canonical fixture per V1 template),
      // not by the rotated account name — account rotation logic can change
      // between seed runs (it did, 2026-08-17: 3 accounts -> 2), and keying
      // by the old composite name left orphaned stale rows with the old
      // "Camera Kit" placeholder behind. Any other v1_scenario_port row for
      // this scenario_type gets replaced, never just left to accumulate.
      const staleRows = await ctx.db
        .query("renter_bot_fixtures")
        .withIndex("by_scenario_type", (q) => q.eq("scenario_type", tpl.scenario_type))
        .filter((q) => q.eq(q.field("source"), "v1_scenario_port"))
        .collect();

      const keep = staleRows.find((r) => r.name === name);
      for (const row of staleRows) {
        if (row._id !== keep?._id) {
          await ctx.db.delete(row._id);
          removedStale++;
        }
      }

      if (keep) {
        await ctx.db.patch(keep._id, fields);
        updated++;
      } else {
        await ctx.db.insert("renter_bot_fixtures", { ...fields, created_at: now });
        inserted++;
      }
    }
    return { inserted, updated, removedStale };
  },
});
