import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { BACKEND_SOURCE_FINGERPRINT, BACKEND_SOURCE_COMMIT } from "./lib/deployment_implementation";

const RESOURCE = "rental-production";
const LEASE_MS = 10 * 60_000;
const ownerFields = { owner: v.string(), sourceCommit: v.string() };
function validateOwner(owner: string, commit: string) {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(owner) || !/^[a-f0-9]{40}$/.test(commit)) throw Error("Invalid deployment identity");
}

/** Private source receipt; does not read or write application data. */
export const current = internalQuery({
  args: {},
  handler: async () => ({ sourceFingerprint: BACKEND_SOURCE_FINGERPRINT, sourceCommit: BACKEND_SOURCE_COMMIT, deploymentUrl: process.env.CONVEX_CLOUD_URL }),
});

/** Both GitHub and Vercel publishers use this lease, so their atomic code
 * pushes cannot race. Every operation is indexed and touches at most one row. */
export const acquire = internalMutation({
  args: ownerFields,
  handler: async (ctx, args) => {
    validateOwner(args.owner, args.sourceCommit);
    const now = Date.now();
    const row = await ctx.db.query("deployment_leases").withIndex("by_resource", q => q.eq("resource", RESOURCE)).unique();
    if (row && row.owner !== args.owner && row.expiresAt > now) return { acquired: false, expiresAt: row.expiresAt };
    const fields = { resource: RESOURCE, ...args, expiresAt: now + LEASE_MS };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("deployment_leases", fields);
    return { acquired: true, expiresAt: fields.expiresAt };
  },
});

export const renew = internalMutation({
  args: ownerFields,
  handler: async (ctx, args) => {
    validateOwner(args.owner, args.sourceCommit);
    const row = await ctx.db.query("deployment_leases").withIndex("by_resource", q => q.eq("resource", RESOURCE)).unique();
    const now = Date.now();
    if (!row || row.owner !== args.owner || row.sourceCommit !== args.sourceCommit || row.expiresAt <= now) return { renewed: false };
    const expiresAt = now + LEASE_MS;
    await ctx.db.patch(row._id, { expiresAt });
    return { renewed: true, expiresAt };
  },
});

export const release = internalMutation({
  args: ownerFields,
  handler: async (ctx, args) => {
    validateOwner(args.owner, args.sourceCommit);
    const row = await ctx.db.query("deployment_leases").withIndex("by_resource", q => q.eq("resource", RESOURCE)).unique();
    if (!row || row.owner !== args.owner || row.sourceCommit !== args.sourceCommit) return { released: false };
    await ctx.db.patch(row._id, { owner: "", expiresAt: 0 });
    return { released: true };
  },
});
