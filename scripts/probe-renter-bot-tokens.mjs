#!/usr/bin/env node
/**
 * probe-renter-bot-tokens.mjs — where do the renter bot's tokens actually go?
 *
 * Calls the REAL agent twice on the same probe thread and reports OpenRouter's
 * own usage accounting, so prompt-size work is aimed with data instead of
 * guesses. Specifically answers:
 *
 *   1. How many prompt tokens does one draft actually cost?
 *   2. How many of them are being served from cache?
 *   3. Does the cache_control breakpoint on the CONVERSATION_CRAFT system
 *      message also cover the ~3.2k-token system prompt that Mastra adds
 *      BEFORE it? (Prefix caching caches everything up to and including the
 *      breakpoint, so this depends on message ORDER — which Mastra controls,
 *      not us. Worth verifying rather than assuming.)
 *
 * Read-only apart from a __probe__ thread, which is swept at the end.
 *
 *   node scripts/probe-renter-bot-tokens.mjs
 */
import { execFileSync } from "node:child_process";

const CVX = "./node_modules/.bin/convex";
const THREAD = "__probe__tokens";

function cvx(fn, args) {
  const out = execFileSync(CVX, ["run", fn, JSON.stringify(args)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  }).trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

cvx("renter_bot_probe:seed", {
  thread_id: THREAD,
  account_slug: "leo",
  stage: "INQUIRY",
  items: [{ name: "BMPCC 6K Pro" }],
  messages: [{ role: "renter", text: "hi is this available tomorrow?" }],
});

console.log("calling the real draft path twice (2nd should hit a warm cache)...\n");
for (const label of ["call 1", "call 2"]) {
  const t0 = Date.now();
  const r = cvx("replyInbox_actions:generateDraft", { thread_id: THREAD });
  const ms = Date.now() - t0;
  const u = r?.usage ?? null;
  console.log(
    `${label}: ${ms}ms status=${r?.status ?? "?"}` +
      (u
        ? ` prompt=${u.promptTokens ?? u.prompt_tokens ?? "?"} cached=${u.cachedPromptTokens ?? u.prompt_tokens_details?.cached_tokens ?? "?"}`
        : " (no usage surfaced by this path)"),
  );
}

cvx("renter_bot_probe:cleanup", {});
console.log(
  "\nIf usage is not surfaced above, the draft path does not return it — see\n" +
    "scripts/probe-openrouter-cache.mjs, which measures the same effect\n" +
    "directly against OpenRouter and DOES report cached tokens and cost.",
);
