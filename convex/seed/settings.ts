import { internalMutation } from "../_generated/server";

// Phase 1.B.3 — apply 12 policy decisions to the settings singleton + items schema.
// MASTER SAFETY RAIL: ALLOW_HYGGLO_SEND must stay false; read_only_mode must stay true.
// IMPORTANT: read_only_mode is the UMBRELLA safety flag. Downstream code MUST check this
// BEFORE auto-accepting any Hygglo booking, sending any message, declining a request,
// or modifying any listing. There is no separate `auto_accept_enabled` flag — auto-accept
// is gated SOLELY by `!settings.read_only_mode`.

const now = () => Date.now();

const POLICY_NOTES = [
  "[2026-05-08 phase 1.B.3]",
  "- read_only_mode is the umbrella safety flag; controls send + auto_accept jointly",
  "- Late fees: bot NEVER informs renters; only Telegram alerts to operator",
  "- Off-platform payment: bank details ONLY for delivery fees + agreed broken-item repayments; NEVER as platform-fee-skipping alternative (enforced via persona prompt only per current decision; revisit if model drift observed)",
  "- Per-item cancellation policy lives in items.cancellation_policy, scraped from Hygglo listing bottom every 60d",
  "- Hygglo Care insurance: usually covered except negligence; exact terms in settings.hygglo_care_terms (scraped every 30d from Hygglo)",
  "- Cross-account renter blacklist confirmed account-agnostic",
].join("\n");

const READ_ONLY_MODE_BLOCKS = [
  "hygglo_send",
  "hygglo_auto_accept",
  "hygglo_decline",
  "hygglo_modify_listing",
];

export const apply_phase_1_b3_policies = internalMutation({
  args: {},
  handler: async (ctx) => {
    const t = now();

    // 1) settings singleton — patch with new policy fields, preserve existing.
    const existing = await ctx.db.query("settings").collect();
    if (existing.length === 0) {
      throw new Error(
        "settings row missing — run inventory.seedSettings first (must already exist with ALLOW_HYGGLO_SEND=false, read_only_mode=true)",
      );
    }
    if (existing.length > 1) {
      throw new Error(`settings is a singleton but ${existing.length} rows found`);
    }
    const s = existing[0];

    // Hard-enforce safety rails (must remain false/true).
    const ALLOW_HYGGLO_SEND = false;
    const read_only_mode = true;

    await ctx.db.patch(s._id, {
      ALLOW_HYGGLO_SEND,
      read_only_mode,
      // Phase 1.B.3 additions
      read_only_mode_blocks: READ_ONLY_MODE_BLOCKS,
      hygglo_care_terms: undefined, // null until Phase 3 Stagehand scrape
      hygglo_care_terms_last_synced: undefined,
      hygglo_care_terms_refresh_cadence_days: 30,
      cancellation_policy_refresh_cadence_days: 60,
      timezone: "Europe/London",
      quiet_hours: {
        start: "02:00",
        end: "07:00",
        tz: "Europe/London",
      },
      pickup_no_show_grace_minutes: 30,
      price_objection_surfacing: {
        dashboard: true,
        telegram_alerts: false,
        weekly_digest: false,
      },
      policy_notes: POLICY_NOTES,
      updated_at: t,
    });

    await ctx.db.insert("audit_log", {
      table_name: "settings",
      actor: "p1_b3_policy_apply",
      op: "update",
      count: 1,
      source_file: "convex/seed/settings.ts",
      note: "merge_policies: phase 1.B.3 — added read_only_mode_blocks, quiet_hours, refresh cadences, timezone, pickup_no_show_grace_minutes, price_objection_surfacing, policy_notes; reaffirmed ALLOW_HYGGLO_SEND=false, read_only_mode=true",
      ts: t,
    });

    // 3) items — schema-add audit (no row mutation; cancellation_policy stays undefined).
    // Confirm rows are queryable post-schema-push.
    const items = await ctx.db.query("items").collect();
    const items_count = items.length;
    const items_with_policy = items.filter((it: any) => typeof it.cancellation_policy === "string").length;

    await ctx.db.insert("audit_log", {
      table_name: "items",
      actor: "p1_b3_policy_apply",
      op: "update",
      count: items_count,
      source_file: "convex/schema.ts",
      note: `schema_add_cancellation_policy: ${items_count} items queryable with new optional column; ${items_with_policy} pre-populated (expected 0 — Phase 3 Stagehand will populate)`,
      ts: t,
    });

    return {
      settings_patched: true,
      ALLOW_HYGGLO_SEND,
      read_only_mode,
      read_only_mode_blocks_count: READ_ONLY_MODE_BLOCKS.length,
      items_count,
      items_with_cancellation_policy: items_with_policy,
    };
  },
});

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
        settings.cancellation_policy_refresh_cadence_days === 60 &&
        settings.hygglo_care_terms_refresh_cadence_days === 30 &&
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
