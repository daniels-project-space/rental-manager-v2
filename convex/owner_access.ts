import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { OWNER_RESET_SECONDS } from "./lib/owner_recovery";

export const get = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("owner_access").first(),
});

/** Atomic per-owner limits also protect against rotating caller IP addresses.
 * owner_access is an enforced singleton, so this lookup is bounded to one row. */
export const reserveRecoveryMail = internalMutation({
  args: { auth_user_id: v.string(), email: v.string(), token_hash: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.token_hash)) throw Error("Invalid recovery digest");
    const owner = await ctx.db.query("owner_access").first();
    if (!owner || owner.auth_user_id !== args.auth_user_id || owner.email !== args.email.trim().toLowerCase()) return false;
    const now = Date.now();
    if (owner.recovery_mail_requested_at !== undefined && now - owner.recovery_mail_requested_at < 60_000) return false;
    const start = owner.recovery_mail_window_started_at;
    const sameWindow = start !== undefined && now - start < 3_600_000;
    const count = sameWindow ? owner.recovery_mail_window_count ?? 0 : 0;
    if (count >= 5) return false;
    await ctx.db.patch(owner._id, {
      recovery_mail_requested_at: now,
      recovery_mail_window_started_at: sameWindow ? start : now,
      recovery_mail_window_count: count + 1,
      // A new anonymous request must not invalidate the owner's existing email.
      // At most five links can be issued per hour; any successful claim retires all.
      recovery_tokens: [...(owner.recovery_tokens ?? []).filter(t => t.expires_at > now).slice(-4),
        { hash: args.token_hash, expires_at: now + OWNER_RESET_SECONDS * 1000 }],
    });
    return true;
  },
});

/** OCC makes this claim single-use across concurrent reset requests. Only
 * bounded hashes are retained; bearer values never are. */
export const claimRecoveryToken = internalMutation({
  args: { token_hash: v.string() },
  handler: async (ctx, args) => {
    const owner = await ctx.db.query("owner_access").first();
    const now = Date.now();
    if (!owner?.recovery_tokens?.some(t => t.hash === args.token_hash && t.expires_at > now)) return false;
    await ctx.db.patch(owner._id, { recovery_tokens: [], recovery_token_consumed_at: now });
    return true;
  },
});

/** Atomic singleton binding: two simultaneous signups cannot claim two owners. */
export const register = internalMutation({
  args: { auth_user_id: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("owner_access").first();
    if (existing) {
      if (existing.auth_user_id === args.auth_user_id) return existing._id;
      throw new Error("Owner setup has already been completed.");
    }
    return ctx.db.insert("owner_access", {
      auth_user_id: args.auth_user_id,
      email: args.email.trim().toLowerCase(),
      created_at: Date.now(),
    });
  },
});
