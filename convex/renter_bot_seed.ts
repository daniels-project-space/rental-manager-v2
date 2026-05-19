/**
 * Renter-bot Phase 1 seeding mutations.
 *
 * Usage:
 *   npx convex run renter_bot_seed:seedAll
 *
 * Idempotent: each entry is upserted by (category, name) for rules,
 * (scope, title) for memories. Re-running won't duplicate.
 *
 * READ-ONLY guarantee: this file ONLY writes to the `rules` and
 * `memories` tables. Never touches reservations / hygglo_messages /
 * any Hygglo write API.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { RENTER_BOT_RULES_V1 } from "./seed/renter_bot_rules";
import { RENTER_BOT_MEMORIES_V1 } from "./seed/renter_bot_memories";

export const seedRules = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }): Promise<{
    inserted: number;
    updated: number;
    total: number;
  }> => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    // Pre-fetch all existing rules from V1-port source for fast dedup.
    const existingRows = await ctx.db
      .query("rules")
      .withIndex("by_category")
      .collect();
    const existingByKey = new Map<string, (typeof existingRows)[number]>();
    for (const r of existingRows) {
      if (r.source !== "v1-port") continue;
      existingByKey.set(`${r.category}::${r.rule_kind}`, r);
    }

    for (const seed of RENTER_BOT_RULES_V1) {
      const key = `${seed.category}::${seed.name}`;
      const existing = existingByKey.get(key);
      if (existing) {
        if (dryRun) {
          updated += 1;
          continue;
        }
        await ctx.db.patch(existing._id, {
          rule_body: seed.body,
          priority: seed.priority,
          enabled: true,
        });
        updated += 1;
        continue;
      }
      if (dryRun) {
        inserted += 1;
        continue;
      }
      await ctx.db.insert("rules", {
        rule_kind: seed.name,
        rule_body: seed.body,
        category: seed.category,
        priority: seed.priority,
        enabled: true,
        source: "v1-port",
        created_at: now,
      });
      inserted += 1;
    }

    if (!dryRun) {
      await ctx.db.insert("audit_log", {
        table_name: "rules",
        actor: "renter-bot-seed",
        op: "insert",
        count: inserted,
        source_file: "convex/renter_bot_seed.ts:seedRules",
        note: `V1 port: inserted=${inserted} updated=${updated}`,
        ts: now,
      });
    }
    return { inserted, updated, total: RENTER_BOT_RULES_V1.length };
  },
});

export const seedMemories = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }): Promise<{
    inserted: number;
    updated: number;
    total: number;
  }> => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    const existingRows = await ctx.db.query("memories").collect();
    const existingByKey = new Map<string, (typeof existingRows)[number]>();
    for (const m of existingRows) {
      if (m.source !== "v1-port") continue;
      if (!m.title) continue;
      existingByKey.set(`${m.scope}::${m.title}`, m);
    }

    for (const seed of RENTER_BOT_MEMORIES_V1) {
      const key = `${seed.scope}::${seed.title}`;
      const existing = existingByKey.get(key);
      if (existing) {
        if (dryRun) {
          updated += 1;
          continue;
        }
        await ctx.db.patch(existing._id, {
          content: seed.content,
          tags: seed.tags,
          priority: seed.priority,
          updated_at: now,
        });
        updated += 1;
        continue;
      }
      if (dryRun) {
        inserted += 1;
        continue;
      }
      await ctx.db.insert("memories", {
        scope: seed.scope,
        title: seed.title,
        content: seed.content,
        tags: seed.tags,
        priority: seed.priority,
        source: "v1-port",
        created_at: now,
      });
      inserted += 1;
    }

    if (!dryRun) {
      await ctx.db.insert("audit_log", {
        table_name: "memories",
        actor: "renter-bot-seed",
        op: "insert",
        count: inserted,
        source_file: "convex/renter_bot_seed.ts:seedMemories",
        note: `V1 port: inserted=${inserted} updated=${updated}`,
        ts: now,
      });
    }
    return { inserted, updated, total: RENTER_BOT_MEMORIES_V1.length };
  },
});

/**
 * Convenience entrypoint — runs both seeders inline (Convex's cross-file
 * runMutation typing didn't survive typegen, so the two seeders re-do
 * the work directly here instead).
 */
export const seedAll = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }): Promise<{
    rules: { inserted: number; updated: number; total: number };
    memories: { inserted: number; updated: number; total: number };
  }> => {
    const now = Date.now();

    // ── Rules ──
    let rulesInserted = 0;
    let rulesUpdated = 0;
    const existingRules = await ctx.db
      .query("rules")
      .withIndex("by_category")
      .collect();
    const ruleIdx = new Map<string, (typeof existingRules)[number]>();
    for (const r of existingRules) {
      if (r.source !== "v1-port") continue;
      ruleIdx.set(`${r.category}::${r.rule_kind}`, r);
    }
    for (const seed of RENTER_BOT_RULES_V1) {
      const existing = ruleIdx.get(`${seed.category}::${seed.name}`);
      if (existing) {
        if (!dryRun) {
          await ctx.db.patch(existing._id, {
            rule_body: seed.body,
            priority: seed.priority,
            enabled: true,
          });
        }
        rulesUpdated += 1;
        continue;
      }
      if (!dryRun) {
        await ctx.db.insert("rules", {
          rule_kind: seed.name,
          rule_body: seed.body,
          category: seed.category,
          priority: seed.priority,
          enabled: true,
          source: "v1-port",
          created_at: now,
        });
      }
      rulesInserted += 1;
    }

    // ── Memories ──
    let memsInserted = 0;
    let memsUpdated = 0;
    const existingMems = await ctx.db.query("memories").collect();
    const memIdx = new Map<string, (typeof existingMems)[number]>();
    for (const m of existingMems) {
      if (m.source !== "v1-port") continue;
      if (!m.title) continue;
      memIdx.set(`${m.scope}::${m.title}`, m);
    }
    for (const seed of RENTER_BOT_MEMORIES_V1) {
      const existing = memIdx.get(`${seed.scope}::${seed.title}`);
      if (existing) {
        if (!dryRun) {
          await ctx.db.patch(existing._id, {
            content: seed.content,
            tags: seed.tags,
            priority: seed.priority,
            updated_at: now,
          });
        }
        memsUpdated += 1;
        continue;
      }
      if (!dryRun) {
        await ctx.db.insert("memories", {
          scope: seed.scope,
          title: seed.title,
          content: seed.content,
          tags: seed.tags,
          priority: seed.priority,
          source: "v1-port",
          created_at: now,
        });
      }
      memsInserted += 1;
    }

    if (!dryRun) {
      await ctx.db.insert("audit_log", {
        table_name: "rules+memories",
        actor: "renter-bot-seed",
        op: "insert",
        count: rulesInserted + memsInserted,
        source_file: "convex/renter_bot_seed.ts:seedAll",
        note: `rules ins=${rulesInserted} upd=${rulesUpdated}; memories ins=${memsInserted} upd=${memsUpdated}`,
        ts: now,
      });
    }

    return {
      rules: { inserted: rulesInserted, updated: rulesUpdated, total: RENTER_BOT_RULES_V1.length },
      memories: { inserted: memsInserted, updated: memsUpdated, total: RENTER_BOT_MEMORIES_V1.length },
    };
  },
});
