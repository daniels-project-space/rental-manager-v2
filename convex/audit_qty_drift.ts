/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Layer B (2026-05-19) — qty-drift audit action.
 *
 *  Re-fetches Hygglo /v4/my/orders/{id} for active reservations and compares
 *  `raw items[].length` (gear units the renter actually has) vs the row's
 *  `expanded_items` (what the dashboard double-booking detector reads).
 *
 *  Drift kinds:
 *    listing_count_lt_items — sum(expanded_items[].qty) < items[].length
 *    unique_sku_lt_items    — expanded_items distinct SKU count < items[].length
 *
 *  Open rows persist in `qty_drift_alerts` until manually resolved or the
 *  Layer C backfill (admin_backfill_qty_resolution) clears them by re-running
 *  the per-listing resolver.
 *
 *  Run manually:
 *    npx convex run audit_qty_drift:auditItemQuantities '{"only_active": true}'
 *
 *  Runs nightly via convex/crons.ts (03:00 UTC, only_active=true).
 * ──────────────────────────────────────────────────────────────────────────
 */

"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const COUNTRY = "GB";

// ── Vault + Hygglo auth helpers (mirrors admin_backfill_hygglo_signals.ts) ──

async function getVaultSecrets(service: string): Promise<Record<string, string>> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`vault fetch failed: ${res.status}`);
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  const out: Record<string, string> = {};
  for (const s of data.value ?? []) out[s.keyName] = s.value;
  return out;
}

async function loginOnce(
  email: string,
  password: string,
  clientSecret: string,
): Promise<string | null> {
  if (!email || !password) return null;
  const params = new URLSearchParams({
    grant_type: "password",
    username: email,
    password,
    client_id: CLIENT_ID,
    client_secret: clientSecret,
  });
  const r = await fetch(`${API_BASE}/token?country=${COUNTRY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Client": "Hygglo-web",
      Origin: "https://www.hygglo.com",
    },
    body: params.toString(),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { access_token?: string }).access_token ?? null;
}

interface HyggloOrderDetail {
  id?: number;
  items?: Array<{ name?: string; type?: string; qty?: number }>;
}

async function fetchOrderDetail(
  token: string,
  orderId: string,
): Promise<HyggloOrderDetail | null> {
  const r = await fetch(
    `${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Country: COUNTRY,
        "User-Client": "Hygglo-web",
      },
    },
  );
  if (!r.ok) return null;
  return (await r.json()) as HyggloOrderDetail;
}

// ── Main audit action ──────────────────────────────────────────────────────

export const auditItemQuantities = internalAction({
  args: {
    account_slug: v.optional(v.string()),
    only_active: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { account_slug, only_active = true, limit = 500 },
  ): Promise<{
    scanned: number;
    drift_opened: number;
    by_kind: Record<string, number>;
    by_account: Record<string, number>;
    skipped_no_hygglo_id: number;
    skipped_inaccessible: number;
  }> => {
    // 1. Load creds + lazy login per account
    const sec = await getVaultSecrets("hygglo");
    const clientSecret =
      sec.HYGGLO_CLIENT_SECRET ?? "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
    const accounts: Record<string, { email?: string; password?: string }> = {
      dbcinema: {
        email: sec.HYGGLO_DBCINEMA_EMAIL,
        password: sec.HYGGLO_DBCINEMA_PASSWORD,
      },
      leo: {
        email: sec.HYGGLO_LEO_EMAIL,
        password: sec.HYGGLO_LEO_PASSWORD,
      },
      diogo: {
        email: sec.HYGGLO_DIOGO_EMAIL,
        password: sec.HYGGLO_DIOGO_PASSWORD,
      },
    };
    const tokens: Record<string, string | null> = {};
    async function getToken(slug: string): Promise<string | null> {
      if (slug in tokens) return tokens[slug];
      const acc = accounts[slug];
      if (!acc?.email || !acc?.password) {
        tokens[slug] = null;
        return null;
      }
      tokens[slug] = await loginOnce(acc.email, acc.password, clientSecret);
      return tokens[slug];
    }

    // 2. Pull candidate reservations
    const candidates: Array<{
      _id: Id<"reservations">;
      hygglo_order_id?: string;
      account_slug?: string;
      renter_name?: string;
      items_length: number;
      expanded_items_n: number;
      expanded_unique_skus: number;
    }> = await ctx.runQuery(
      internal.audit_qty_drift_data.listAuditCandidates,
      { account_slug, only_active, limit },
    );

    const by_kind: Record<string, number> = {};
    const by_account: Record<string, number> = {};
    let drift_opened = 0;
    let skipped_no_hygglo_id = 0;
    let skipped_inaccessible = 0;
    const now = Date.now();

    for (const r of candidates) {
      if (!r.hygglo_order_id) {
        skipped_no_hygglo_id++;
        continue;
      }
      const slug = r.account_slug ?? "";
      const token = await getToken(slug);
      if (!token) {
        skipped_inaccessible++;
        continue;
      }
      const detail = await fetchOrderDetail(token, r.hygglo_order_id);
      if (!detail) {
        skipped_inaccessible++;
        continue;
      }
      const rawItems = Array.isArray(detail.items) ? detail.items : [];
      const raw_n = rawItems.length;

      // Drift detection.
      // listing_count_lt_items: total expanded qty < raw listing count
      //   (Olivia's 2x FX3 in same order: raw_n=2, expanded sum=1)
      // unique_sku_lt_items: distinct expanded SKUs < raw listing count
      //   (signal for resolver collapsing same-SKU multi-listings into one row)
      let drift_kind: "listing_count_lt_items" | "unique_sku_lt_items" | null = null;
      if (raw_n > 1 && r.expanded_items_n < raw_n) {
        drift_kind = "listing_count_lt_items";
      } else if (raw_n > 1 && r.expanded_unique_skus < raw_n && r.expanded_items_n < raw_n) {
        drift_kind = "unique_sku_lt_items";
      }
      if (!drift_kind) continue;

      // Diagnostic: list raw item names so reviewer can spot which SKU was dropped.
      const missing_skus = rawItems
        .map((i) => i.name ?? "")
        .filter((n) => n.length > 0)
        .slice(0, 10);

      await ctx.runMutation(internal.audit_qty_drift_data.upsertDriftAlert, {
        reservation_id: r._id,
        hygglo_order_id: r.hygglo_order_id,
        renter_name: r.renter_name,
        account_slug: r.account_slug,
        drift_kind,
        raw_n,
        expanded_n: r.expanded_items_n,
        missing_skus,
        detected_at: now,
      });
      drift_opened++;
      by_kind[drift_kind] = (by_kind[drift_kind] ?? 0) + 1;
      by_account[slug] = (by_account[slug] ?? 0) + 1;
    }

    return {
      scanned: candidates.length,
      drift_opened,
      by_kind,
      by_account,
      skipped_no_hygglo_id,
      skipped_inaccessible,
    };
  },
});
