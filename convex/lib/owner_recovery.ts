import { ownerReturnTo } from "../../src/lib/owner-navigation";

export const OWNER_RESET_SECONDS = 15 * 60;

export async function ownerResetTokenHash(token: string) {
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw Error("Invalid recovery token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Server configuration only; never fall back to another project's sender or origin. */
export function ownerRecoveryConfig() {
  const key = process.env.OWNER_RECOVERY_RESEND_API_KEY;
  const from = process.env.OWNER_RECOVERY_FROM;
  const site = new URL(process.env.SITE_URL ?? "https://invalid.invalid");
  const local = site.protocol === "http:" && ["127.0.0.1", "localhost"].includes(site.hostname);
  if (!key?.startsWith("re_") || !from || /[\r\n]/.test(from) ||
      !/@dbcinemarentals\.com>?$/.test(from) ||
      site.hostname === "invalid.invalid" || (!local && site.protocol !== "https:") ||
      site.username || site.password || site.pathname !== "/" || site.search || site.hash)
    throw Error("Owner recovery is temporarily unavailable. Please try again later.");
  return { key, from, origin: site.origin };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The bearer reset token is a fragment, absent from HTTP requests and referrers. */
export function ownerRecoveryLink(origin: string, token: string, callbackUrl: string) {
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw Error("Invalid recovery token");
  const link = new URL("/login", origin);
  const source = new URL(callbackUrl);
  const callback = source.searchParams.get("callbackURL");
  if (callback) {
    const target = new URL(callback, origin);
    if (target.origin !== origin || target.pathname !== "/login") throw Error("Invalid recovery destination");
    const returnTo = ownerReturnTo(target.searchParams.get("returnTo"));
    if (returnTo !== "/") link.searchParams.set("returnTo", returnTo);
  }
  link.hash = new URLSearchParams({ reset: token }).toString();
  return link.href;
}

export async function sendOwnerRecovery(email: string, token: string, callbackUrl: string) {
  const { key, from, origin } = ownerRecoveryConfig();
  const link = ownerRecoveryLink(origin, token, callbackUrl);
  const idempotency = await ownerResetTokenHash(token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `rm-owner-reset-${idempotency}` },
    signal: controller.signal,
    body: JSON.stringify({
      from, to: [email], subject: "Reset your Rental Manager password",
      text: `Reset your Rental Manager password\n\n${link}\n\nThis single-use link expires in 15 minutes. Resetting your password signs out your existing sessions. If you did not request this, ignore this email.`,
      html: `<div style="background:#070910;padding:40px 20px;font-family:Arial,sans-serif;color:#eee"><div style="max-width:520px;margin:auto;border:1px solid #333;border-radius:16px;padding:32px;background:#12141b"><p style="color:#bd8a68;letter-spacing:3px;font-size:12px">DB CINEMA · RENTAL MANAGER</p><h1 style="font-size:26px">Reset your password</h1><p>Use this private link to choose a new owner password.</p><p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#aa7858;color:white;padding:14px 22px;border-radius:8px;text-decoration:none">Choose a new password</a></p><p style="color:#bbb;font-size:14px">This single-use link expires in 15 minutes. Your existing sessions will be signed out after the reset.</p><p style="color:#999;font-size:13px">If you didn’t request this, you can safely ignore this email.</p></div></div>`,
    }),
  });
  if (!response.ok) throw Error("Owner recovery is temporarily unavailable. Please try again later.");
  const receipt = await response.json() as { id?: string };
  if (!receipt.id) throw Error("Owner recovery could not be confirmed. Please try again later.");
  } finally { clearTimeout(timeout); }
}
