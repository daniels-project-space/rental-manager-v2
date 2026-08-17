"use node";
/**
 * renter_bot_fixture_import — READ-ONLY import of a real historical Hygglo
 * conversation into a renter_bot_fixtures row, for harness replay against the
 * REAL generateDraft pipeline.
 *
 * Uses only hygglo-core's getOrder (a GET) via createHyggloCore. Never calls
 * core.orders / core.catalog (the typed-but-not-live write namespaces) or
 * core.sendMessage (which throws by design — see hygglo-core/index.ts).
 * Writes exclusively via renter_bot_fixture_import_db.insertFixture (never
 * to hygglo_messages or conversations) — an import is inert until a harness
 * run explicitly uses it. The DB write is in a separate file because Convex
 * mutations can't live in a "use node" file.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { createHyggloCore } from "../src/hygglo-core";

export const importFromHygglo = action({
  args: {
    accountSlug: v.string(),
    hyggloOrderId: v.string(),
    name: v.optional(v.string()),
    scenarioType: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ fixtureId: string; messageCount: number }> => {
    const core = createHyggloCore(args.accountSlug);
    const detail = await core.getOrder(args.hyggloOrderId);
    const fetchedAt = Date.now();

    const messages = core.shape
      .orderToMessages(detail, fetchedAt)
      .filter(
        (m): m is typeof m & { hygglo_sent_at: number } =>
          m.hygglo_sent_at != null,
      )
      .map((m) => ({
        role: (m.sender === "owner" ? "owner" : "renter") as
          | "owner"
          | "renter",
        text: m.body_text,
        at: m.hygglo_sent_at,
      }));

    const { inquiry_items } = core.shape.orderToInquiryItems(detail);
    const items = (inquiry_items ?? []).map((i) => i.name);

    const fixtureId: string = await ctx.runMutation(
      internal.renter_bot_fixture_import_db.insertFixture,
      {
        name: args.name ?? `hygglo-import-${args.hyggloOrderId}`,
        account_slug: args.accountSlug,
        scenario_type: args.scenarioType ?? "imported_transcript",
        source: "hygglo_import" as const,
        hygglo_order_id: String(args.hyggloOrderId),
        seed_context: items.length ? { items } : undefined,
        messages,
        description: args.description,
        active: true,
        created_at: fetchedAt,
        created_by: "import",
      },
    );
    return { fixtureId, messageCount: messages.length };
  },
});
