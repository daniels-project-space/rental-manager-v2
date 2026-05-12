import { internalMutation } from "../_generated/server";

// Read-only verification helper for Task G invariants.
export const verify_p1_b3_invariants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db.query("settings").first();
    const profiles = await ctx.db.query("account_profiles").collect();
    const items = await ctx.db.query("items").collect();

    const off_platform_clause = "HARD POLICY — OFF-PLATFORM PAYMENT";
    return {
      // Invariant 1
      ALLOW_HYGGLO_SEND_eq_false: settings?.ALLOW_HYGGLO_SEND === false,
      // Invariant 2
      read_only_mode_eq_true: settings?.read_only_mode === true,
      // Invariant 3
      settings_new_fields_present: !!(
        settings?.read_only_mode_blocks &&
        settings.read_only_mode_blocks.length >= 4 &&
        settings.timezone === "Europe/London" &&
        settings.quiet_hours &&
        settings.pickup_no_show_grace_minutes === 30 &&
        settings.price_objection_surfacing &&
        settings.policy_notes
      ),
      // Invariant 4
      items_count: items.length,
      items_cancellation_policy_queryable: items.every((it: any) =>
        typeof it.cancellation_policy === "string" || it.cancellation_policy === undefined,
      ),
      // Invariant 5
      account_profiles_count: profiles.length,
      both_have_telegram_alert_only: profiles.every(
        (p: any) => p.rules?.late_return?.telegram_alert_only === true,
      ),
      both_have_off_platform_payment: profiles.every(
        (p: any) => Array.isArray(p.rules?.off_platform_payment?.allowed_contexts) &&
          p.rules.off_platform_payment.allowed_contexts.length >= 2,
      ),
      // Invariant 6
      both_personas_have_off_platform_clause: profiles.every(
        (p: any) => typeof p.persona_prompt === "string" && p.persona_prompt.includes(off_platform_clause),
      ),
    };
  },
});
