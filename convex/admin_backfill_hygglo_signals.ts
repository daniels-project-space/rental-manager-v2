/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Admin Backfill — Hygglo system signals (Phase 3d)
 *
 *  Iterates obsolete reservations, fetches /v4/my/orders/:id for each from
 *  the correct account token, derives `hygglo_system_signal` +
 *  `hygglo_system_signal_text` from activity.event.content, and patches the
 *  reservation row.
 *
 *  Paged action: limit=50/batch (well under Convex 60s action budget for
 *  ~50 outbound API calls). Idempotent (skips rows that already have
 *  `hygglo_system_signal` set unless `force=true`).
 *
 *  Multi-account: looks at reservation.account_slug and dispatches to the
 *  correct Hygglo OAuth token (dbcinema vs leo). Mirrors poll-hygglo.ts:512+.
 *
 *  Sample run:
 *    npx convex run --prod admin_backfill_hygglo_signals:backfillBatch '{"limit":50}'
 *
 *  Internal queries/mutations live in admin_backfill_hygglo_signals_data.ts
 *  (Convex requires "use node" actions to be in a separate module from
 *  query/mutation handlers).
 * ──────────────────────────────────────────────────────────────────────────
 */

"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
// B5 — single canonical copy of the signal derivation (was triplicated). This
// pure module has no `server-only` / framework deps, so the "use node" action
// can import it the same way other convex modules import from ../src/lib/*.
import { deriveHyggloSystemSignal } from "../src/hygglo-core/signals";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const COUNTRY = "GB";

type Activity = {
  key?: string;
  chatMessage?: { text?: { content?: string }; byMe?: boolean };
  event?: { title?: string; content?: string };
  createdAtLabel?: string;
};

type OrderDetail = { id?: number; activities?: Activity[] };

// ── Vault helper ──────────────────────────────────────────────────────────

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

// ── Hygglo OAuth login ───────────────────────────────────────────────────

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

async function fetchOrderDetail(
  token: string,
  orderId: string,
): Promise<OrderDetail | null> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Country: COUNTRY,
    "User-Client": "Hygglo-web",
  };
  const r = await fetch(
    `${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`,
    { headers },
  );
  if (!r.ok) return null;
  return (await r.json()) as OrderDetail;
}

// ── Main paged action ─────────────────────────────────────────────────────

export const backfillBatch = action({
  args: {
    limit: v.optional(v.number()),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit = 50, force = false },
  ): Promise<{
    processed: number;
    skipped_inaccessible: number;
    by_signal: Record<string, number>;
    by_account: Record<string, number>;
    pending: number;
  }> => {
    // 1. Load creds
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
    };

    // 2. Login per account (lazy)
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

    // 3. Pull a batch of candidate rows
    const candidates = await ctx.runQuery(
      internal.admin_backfill_hygglo_signals_data.listObsoletesPendingSignal,
      { limit, force },
    );

    let processed = 0;
    let skippedInaccessible = 0;
    const bySignal: Record<string, number> = {};
    const byAccount: Record<string, number> = {};

    for (const c of candidates) {
      const accountSlug = c.account_slug ?? "unknown";
      if (!c.hygglo_order_id || !c.account_slug) {
        await ctx.runMutation(
          internal.admin_backfill_hygglo_signals_data.patchSignal,
          {
            _id: c._id as Id<"reservations">,
            hygglo_system_signal: "none",
          },
        );
        bySignal.none = (bySignal.none ?? 0) + 1;
        byAccount[accountSlug] = (byAccount[accountSlug] ?? 0) + 1;
        processed++;
        continue;
      }
      const token = await getToken(c.account_slug);
      if (!token) {
        await ctx.runMutation(
          internal.admin_backfill_hygglo_signals_data.patchSignal,
          {
            _id: c._id as Id<"reservations">,
            hygglo_system_signal: "none",
          },
        );
        bySignal.none = (bySignal.none ?? 0) + 1;
        byAccount[accountSlug] = (byAccount[accountSlug] ?? 0) + 1;
        skippedInaccessible++;
        processed++;
        continue;
      }
      const detail = await fetchOrderDetail(token, c.hygglo_order_id);
      if (!detail) {
        // 404 / forbidden — row belongs to another account or was deleted.
        await ctx.runMutation(
          internal.admin_backfill_hygglo_signals_data.patchSignal,
          {
            _id: c._id as Id<"reservations">,
            hygglo_system_signal: "none",
          },
        );
        bySignal.none = (bySignal.none ?? 0) + 1;
        byAccount[accountSlug] = (byAccount[accountSlug] ?? 0) + 1;
        skippedInaccessible++;
        processed++;
        continue;
      }
      const { signal, text } = deriveHyggloSystemSignal(detail.activities ?? []);
      await ctx.runMutation(
        internal.admin_backfill_hygglo_signals_data.patchSignal,
        {
          _id: c._id as Id<"reservations">,
          hygglo_system_signal: signal,
          ...(text !== undefined && { hygglo_system_signal_text: text }),
        },
      );
      bySignal[signal] = (bySignal[signal] ?? 0) + 1;
      byAccount[accountSlug] = (byAccount[accountSlug] ?? 0) + 1;
      processed++;
    }

    // 4. Estimate pending
    const pending = await ctx.runQuery(
      internal.admin_backfill_hygglo_signals_data.countPending,
      { force },
    );

    return {
      processed,
      skipped_inaccessible: skippedInaccessible,
      by_signal: bySignal,
      by_account: byAccount,
      pending,
    };
  },
});
