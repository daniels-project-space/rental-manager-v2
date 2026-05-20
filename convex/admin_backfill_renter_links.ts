/**
 * 2026-05-19 — Backfill renter linkage on reservations.
 *
 * Re-fetches Hygglo order details for reservations missing `renter_name`,
 * `renter_id`, or `hygglo_user_id` and patches the row.
 *
 * Run: npx convex run --prod admin_backfill_renter_links:backfillRenterLinks '{"limit":50}'
 *
 * Idempotent. Skips rows that already have all three fields set, and rows
 * marked is_obsolete. Returns counts so the caller can iterate.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  HYGGLO_API_BASE,
  hyggloAuthHeaders,
  getHyggloAccessToken,
  getAccountCredentials,
} from "../src/lib/hygglo-auth";
import type { Doc, Id } from "./_generated/dataModel";

// ── helpers ────────────────────────────────────────────────────

interface OrderDetailMinimal {
  users?: {
    otherPart?: {
      id?: number | string;
      name?: string;
    };
  };
  labels?: {
    otherPart?: string;
  };
}

function extractRenter(detail: OrderDetailMinimal): {
  name?: string;
  user_id?: string;
} {
  const name =
    detail?.users?.otherPart?.name ??
    detail?.labels?.otherPart ??
    undefined;
  const rawId = detail?.users?.otherPart?.id;
  const user_id =
    rawId !== undefined && rawId !== null && String(rawId).length > 0
      ? String(rawId)
      : undefined;
  return { name, user_id };
}

// ── candidate query (internal) ─────────────────────────────────

export const listCandidates = internalQuery({
  args: {
    limit: v.number(),
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { limit, account_slug }) => {
    const rows = await ctx.db.query("reservations").collect();
    const candidates: Array<{
      _id: Id<"reservations">;
      hygglo_order_id?: string;
      account_slug?: string;
      renter_name?: string;
      renter_id?: Id<"renters">;
      hygglo_user_id?: string;
    }> = [];
    for (const r of rows as Doc<"reservations">[]) {
      if (r.is_obsolete) continue;
      if (!r.hygglo_order_id) continue;
      if (account_slug && r.account_slug !== account_slug) continue;
      const missingName = !r.renter_name || r.renter_name.length === 0;
      const missingRenterId = !r.renter_id;
      const missingUserId = !r.hygglo_user_id;
      if (!missingName && !missingRenterId && !missingUserId) continue;
      candidates.push({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id,
        account_slug: r.account_slug,
        renter_name: r.renter_name,
        renter_id: r.renter_id,
        hygglo_user_id: r.hygglo_user_id,
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  },
});

// ── patch mutation (internal) ──────────────────────────────────

export const patchRenterLink = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    renter_name: v.optional(v.string()),
    hygglo_user_id: v.optional(v.string()),
  },
  handler: async (ctx, { reservation_id, renter_name, hygglo_user_id }) => {
    const patch: Record<string, unknown> = {};
    if (renter_name !== undefined && renter_name.length > 0) {
      patch.renter_name = renter_name;
    }
    if (hygglo_user_id !== undefined && hygglo_user_id.length > 0) {
      patch.hygglo_user_id = hygglo_user_id;
      // Look up renter by hygglo_user_id (indexed)
      const renter = await ctx.db
        .query("renters")
        .withIndex("by_hygglo_user_id", (q) =>
          q.eq("hygglo_user_id", hygglo_user_id),
        )
        .first();
      if (renter?._id) {
        patch.renter_id = renter._id;
      }
    }
    if (Object.keys(patch).length === 0) {
      return { patched: false, fields: [] as string[] };
    }
    await ctx.db.patch(reservation_id, patch);
    return { patched: true, fields: Object.keys(patch) };
  },
});

// ── main backfill action ───────────────────────────────────────

export const backfillRenterLinks = internalAction({
  args: {
    limit: v.optional(v.number()),
    account_slug: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { limit, account_slug },
  ): Promise<{
    scanned: number;
    named: number;
    linked: number;
    candidates: number;
    errors: Array<{
      hygglo_order_id?: string;
      account_slug?: string;
      error: string;
    }>;
  }> => {
    const cap = Math.max(1, Math.min(limit ?? 50, 200));
    const candidates: Array<{
      _id: Id<"reservations">;
      hygglo_order_id?: string;
      account_slug?: string;
      renter_name?: string;
      renter_id?: Id<"renters">;
      hygglo_user_id?: string;
    }> = await ctx.runQuery(
      internal.admin_backfill_renter_links.listCandidates,
      { limit: cap, account_slug },
    );

    let scanned = 0;
    let named = 0;
    let linked = 0;
    const errors: Array<{
      hygglo_order_id?: string;
      account_slug?: string;
      error: string;
    }> = [];

    // Token cache per account_slug — avoid re-authing for every order
    const tokenCache = new Map<string, string>();

    // Process in chunks of 10 with a small pause to stay polite to Hygglo
    const CHUNK = 10;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);
      for (const c of chunk) {
        scanned++;
        try {
          if (!c.account_slug || !c.hygglo_order_id) {
            errors.push({
              hygglo_order_id: c.hygglo_order_id,
              account_slug: c.account_slug,
              error: "missing account_slug or hygglo_order_id",
            });
            continue;
          }
          let token = tokenCache.get(c.account_slug);
          if (!token) {
            const creds = await getAccountCredentials(c.account_slug);
            token = await getHyggloAccessToken({
              email: creds.email,
              password: creds.password,
              clientSecret: creds.clientSecret,
              accountSlug: c.account_slug,
            });
            tokenCache.set(c.account_slug, token);
          }
          const res = await fetch(
            `${HYGGLO_API_BASE}/v4/my/orders/${c.hygglo_order_id}?timezone=Europe/London`,
            { headers: hyggloAuthHeaders(token) },
          );
          if (!res.ok) {
            errors.push({
              hygglo_order_id: c.hygglo_order_id,
              account_slug: c.account_slug,
              error: `hygglo http ${res.status}`,
            });
            continue;
          }
          const detail = (await res.json()) as OrderDetailMinimal;
          const { name, user_id } = extractRenter(detail);
          if (!name && !user_id) {
            errors.push({
              hygglo_order_id: c.hygglo_order_id,
              account_slug: c.account_slug,
              error: "no renter info in detail",
            });
            continue;
          }
          const result = await ctx.runMutation(
            internal.admin_backfill_renter_links.patchRenterLink,
            {
              reservation_id: c._id,
              renter_name: name,
              hygglo_user_id: user_id,
            },
          );
          if (result.fields.includes("renter_name")) named++;
          if (result.fields.includes("renter_id")) linked++;
        } catch (err) {
          errors.push({
            hygglo_order_id: c.hygglo_order_id,
            account_slug: c.account_slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // throttle between chunks
      if (i + CHUNK < candidates.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return {
      scanned,
      named,
      linked,
      errors,
      candidates: candidates.length,
    };
  },
});
