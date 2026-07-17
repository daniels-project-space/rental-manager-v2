/**
 * Weekly cron — fetch each account's Hygglo profile image from a sample
 * order detail and patch accounts.profile_image_url. Right now we
 * hand-seeded once; if Daniel changes his Hygglo avatar this catches it.
 */

"use node";

import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";

async function getVaultSecrets(service: string): Promise<Record<string, string>> {
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(VAULT_URL + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service, vaultToken }, format: "json" }),
  });
  if (!res.ok) throw new Error("vault fetch failed: " + res.status);
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  const out: Record<string, string> = {};
  for (const s of data.value ?? []) out[s.keyName] = s.value;
  return out;
}

async function loginOnce(email: string, password: string): Promise<string | null> {
  const params = new URLSearchParams({
    grant_type: "password",
    username: email,
    password,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const tk = await fetch(API_BASE + "/token?country=" + COUNTRY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!tk.ok) return null;
  return ((await tk.json()) as { access_token?: string }).access_token ?? null;
}

async function findOneOrderId(token: string): Promise<string | null> {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json", Country: COUNTRY, "User-Client": "Hygglo-web" };
  for (const filter of ["future", "current", "pending", "obsolete"]) {
    const r = await fetch(API_BASE + "/v4/my/orders?role=owner&filter=" + filter + "&sort=latest-activity&offset=0&limit=5", { headers });
    if (!r.ok) continue;
    const d = await r.json();
    const arr = Array.isArray(d) ? d : ((d as { items?: Array<{ id: number }> }).items ?? []);
    if (arr.length > 0) return String(arr[0].id);
  }
  return null;
}

async function fetchProfileImage(token: string, orderId: string): Promise<string | null> {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json", Country: COUNTRY, "User-Client": "Hygglo-web" };
  const r = await fetch(API_BASE + "/v4/my/orders/" + orderId + "?timezone=Europe/London", { headers });
  if (!r.ok) return null;
  const d = (await r.json()) as {
    users?: { me?: { profileImage?: { fullSizeUrl?: string; thumbnailUrl?: string } } };
  };
  return d.users?.me?.profileImage?.thumbnailUrl ?? d.users?.me?.profileImage?.fullSizeUrl ?? null;
}

export const syncAccountProfiles = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; updated: string[]; errors: string[] }> => {
    const sec = await getVaultSecrets("hygglo");
    const accounts = [
      { slug: "dbcinema", email: sec.HYGGLO_DBCINEMA_EMAIL, password: sec.HYGGLO_DBCINEMA_PASSWORD },
      { slug: "leo", email: sec.HYGGLO_LEO_EMAIL, password: sec.HYGGLO_LEO_PASSWORD },
      { slug: "diogo", email: sec.HYGGLO_DIOGO_EMAIL, password: sec.HYGGLO_DIOGO_PASSWORD },
    ];
    const updated: string[] = [];
    const errors: string[] = [];
    for (const acc of accounts) {
      if (!acc.email || !acc.password) {
        errors.push(acc.slug + ": missing creds");
        continue;
      }
      const token = await loginOnce(acc.email, acc.password);
      if (!token) { errors.push(acc.slug + ": login failed"); continue; }
      const orderId = await findOneOrderId(token);
      if (!orderId) { errors.push(acc.slug + ": no orders to scrape"); continue; }
      const url = await fetchProfileImage(token, orderId);
      if (!url) { errors.push(acc.slug + ": no profileImage in order"); continue; }
      await ctx.runMutation(api.accounts.setProfileImage, { slug: acc.slug, profile_image_url: url });
      updated.push(acc.slug);
    }
    return { ok: errors.length === 0, updated, errors };
  },
});
