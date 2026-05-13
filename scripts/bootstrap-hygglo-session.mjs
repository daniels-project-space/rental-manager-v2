#!/usr/bin/env node
/**
 * Wave 4.6 — Hygglo session bootstrap.
 *
 * Run this LOCALLY (not in Trigger). Launches a non-headless Chromium
 * so Daniel can log into Hygglo manually with the account he wants
 * to automate, then captures storage_state (cookies + localStorage)
 * and uploads it to Convex `hygglo_sessions`.
 *
 * Usage:
 *   node scripts/bootstrap-hygglo-session.mjs <accountSlug>
 *     accountSlug = "dbcinema" | "leo"
 *
 * After capture, the Trigger task `hygglo-ui-action` will restore the
 * storage_state for every browser run — no in-task login needed.
 */
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";

const accountSlug = process.argv[2];
if (!accountSlug || !["dbcinema", "leo"].includes(accountSlug)) {
  console.error("Usage: bootstrap-hygglo-session.mjs <dbcinema|leo>");
  process.exit(1);
}

const CONVEX_URL = process.env.CONVEX_URL ?? "https://exciting-lion-29.convex.cloud";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log("[bootstrap] navigating to Hygglo login…");
  await page.goto("https://www.hygglo.co.uk/login", { waitUntil: "domcontentloaded" });

  console.log(
    "[bootstrap] Please log in manually for account: " + accountSlug +
    "\n[bootstrap] When you are on /profile/my_orders (logged in), press Enter in this terminal."
  );

  // Wait for operator confirmation on stdin
  await new Promise((resolve) => {
    process.stdin.once("data", () => resolve(null));
  });

  console.log("[bootstrap] capturing storage_state…");
  const state = await ctx.storageState();
  const stateJson = JSON.stringify(state);

  const convex = new ConvexHttpClient(CONVEX_URL);
  const expiresHintAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const id = await convex.mutation(
    "hygglo_ui:upsertSession",
    { accountSlug, storageStateJson: stateJson, expiresHintAt },
  );

  console.log(`[bootstrap] OK — saved hygglo_sessions row ${id}`);
  console.log(`[bootstrap] cookie expiry hint: ${new Date(expiresHintAt).toISOString()}`);

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("[bootstrap] FATAL:", err);
  process.exit(1);
});
