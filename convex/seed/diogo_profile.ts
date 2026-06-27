/**
 * One-off seed: give the `diogo` account an account_profiles row.
 *
 * leo + dbcinema were hand-imported from V1 source files; diogo (the 3rd
 * account, added 2026-06-22) never got a profile, so its AI drafts fell back to
 * the generic persona. This gives diogo a real first-person voice. Policy fields
 * (delivery / rules / discount_codes) are intentionally left null so the draft
 * says "I'll confirm" rather than inventing terms we haven't specified.
 *
 * Idempotent — safe to run repeatedly (no-op if a profile already exists).
 */
import { internalMutation } from "../_generated/server";

export const seedDiogoProfile = internalMutation({
  args: {},
  handler: async (ctx) => {
    const account = await ctx.db
      .query("accounts")
      .filter((q) => q.eq(q.field("slug"), "diogo"))
      .first();
    if (!account) return { ok: false, reason: "no diogo account" };

    const existing = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account._id))
      .first();
    if (existing) return { ok: true, reason: "already exists", id: existing._id };

    const now = Date.now();
    const id = await ctx.db.insert("account_profiles", {
      account_id: account._id,
      persona_prompt:
        "You are Diogo, an independent camera and film-gear owner renting out your own kit to people in the UK. " +
        "You speak in the first person as the real owner — 'I', 'my gear', 'I've got' — never 'we' or 'our'. " +
        "You're warm, easygoing and straight-talking, like texting a fellow creative who knows their kit. " +
        "You're helpful and concise; you confirm details you're sure of and say you'll check anything you're not.",
      response_style: {
        person: "first_person_singular",
        tone: "warm, casual, concise",
        emoji: "rare",
        sign_off: "none",
      },
      language: "en-GB",
      created_at: now,
      updated_at: now,
    });
    return { ok: true, reason: "created", id };
  },
});
