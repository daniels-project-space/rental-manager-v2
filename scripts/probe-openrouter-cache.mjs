#!/usr/bin/env node
/**
 * probe-openrouter-cache.mjs
 *
 * Verifies, empirically, that OpenRouter prompt caching actually works for the
 * model we run — BEFORE wiring cache_control through the agent stack.
 *
 * Why this exists: caching fails silently in three different ways. The prompt
 * can sit under the provider's token minimum, the provider can ignore the
 * breakpoint, or a framework wrapper can drop `cache_control` entirely on the
 * way out (a documented bug class — pydantic-ai's OpenRouter model inherits
 * OpenAI base behaviour and silently discards CachePoint items). All three look
 * identical from the outside: it just costs full price. So measure, don't
 * assume.
 *
 * Sends the SAME large static system prompt twice with a cache_control
 * breakpoint and prints OpenRouter's own accounting each time. Expect a
 * negative or zero `cache_discount` on call 1 (the write) and a positive
 * discount plus non-zero `cached_tokens` on call 2 (the read).
 *
 * Read-only: hits the model, touches no project data.
 *
 *   claude-vault-exec openrouter OPENROUTER_API_KEY=OPENROUTER_API_KEY -- \
 *     node scripts/probe-openrouter-cache.mjs [model]
 */
const MODEL = process.argv[2] ?? "google/gemini-3.7-flash";
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("OPENROUTER_API_KEY not present in env — run via claude-vault-exec.");
  process.exit(1);
}

// Comfortably over every published minimum (Gemini Flash is quoted at either
// 1,024 or 4,096 depending on source, so clear the higher one).
const FILLER = Array.from(
  { length: 900 },
  (_, i) =>
    `Rule ${i + 1}: when quoting a rental price, state the daily rate and the total, and never invent kit contents that are not listed in the supplied facts.`,
).join("\n");

const SYSTEM = `You are a rental assistant. Follow these rules exactly.\n\n${FILLER}`;

async function call(label, { breakpoint = true, salt = "" } = {}) {
  // `salt` makes the prefix unique so a previous run's warm cache can't be
  // mistaken for this run's result — essential for the no-breakpoint control,
  // since Gemini also does IMPLICIT caching and would otherwise make an
  // explicit breakpoint look effective when it changed nothing.
  const text = salt ? `${salt}\n${SYSTEM}` : SYSTEM;
  const body = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text,
            ...(breakpoint ? { cache_control: { type: "ephemeral" } } : {}),
          },
        ],
      },
      { role: "user", content: "Reply with exactly the word: ok" },
    ],
    max_tokens: 8,
    usage: { include: true },
  };
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const j = await res.json();
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
    return null;
  }
  const u = j.usage ?? {};
  console.log(
    `${label}: ${ms}ms | prompt=${u.prompt_tokens ?? "?"} ` +
      `cached=${u.prompt_tokens_details?.cached_tokens ?? 0} ` +
      `cache_discount=${u.cache_discount ?? "n/a"} cost=${u.cost ?? "n/a"}`,
  );
  return u;
}

const approxTokens = Math.round(SYSTEM.length / 4);
console.log(`model=${MODEL}  static system prompt ~${approxTokens} tokens\n`);

const run = String(Date.now());

console.log("--- WITH explicit cache_control breakpoint ---");
const a = await call("call 1 (write) ", { salt: `run-${run}-explicit` });
const b = await call("call 2 (read)  ", { salt: `run-${run}-explicit` });

console.log("\n--- CONTROL: no breakpoint (Gemini implicit caching only) ---");
const c = await call("call 1 (write) ", { breakpoint: false, salt: `run-${run}-control` });
const d = await call("call 2 (read)  ", { breakpoint: false, salt: `run-${run}-control` });

const pct = (x, y) => (x && y ? `${(((x - y) / x) * 100).toFixed(1)}%` : "n/a");

console.log();
if (!a || !b || !c || !d) {
  console.log("RESULT: inconclusive — a call failed, see above.");
} else {
  // Compare ABSOLUTE cost, not the within-arm percentage drop. The control
  // shows a far LARGER percentage reduction simply because it starts from an
  // uncached, full-price first call — a big drop from a much worse baseline.
  // Percentages flatter the arm that begins badly; only absolute £ decides.
  console.log(
    `within-arm 2nd-call drop:  explicit ${pct(a.cost, b.cost)}  |  control ${pct(c.cost, d.cost)}`,
  );
  console.log(
    `\nABSOLUTE cost (what actually matters):\n` +
      `  call 1 — explicit ${a.cost} vs control ${c.cost}  → explicit is ${(c.cost / a.cost).toFixed(1)}x cheaper\n` +
      `  call 2 — explicit ${b.cost} vs control ${d.cost}  → explicit is ${(d.cost / b.cost).toFixed(1)}x cheaper`,
  );
  const worthIt = c.cost / a.cost > 1.2 || d.cost / b.cost > 1.2;
  console.log(
    worthIt
      ? `\nRESULT: explicit cache_control is WORTH plumbing through — it is cheaper\n` +
          `in absolute terms on both the first and the repeat call. Gemini's\n` +
          `implicit caching does NOT make it redundant.`
      : `\nRESULT: explicit cache_control adds little over Gemini's implicit\n` +
          `caching on this lane. Don't add the plumbing for it.`,
  );
}
