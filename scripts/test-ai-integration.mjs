/**
 * End-to-end integration test for the new OpenRouter+DeepSeek path.
 *
 * Mimics the EXACT production code paths:
 *   - getLlmModel() from src/lib/llm-client.ts
 *   - gatedGenerateObject + gatedGenerateText
 *   - The real prompts from item_resolver, extract-booking-times, canonicalize-denials
 *   - The real Zod schemas
 *
 * Run: OPENROUTER_API_KEY=... node scripts/test-ai-integration.mjs
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import { z } from "zod";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}

const openrouter = createOpenRouter({ apiKey });
// Pin provider to DeepSeek's own infra (unknown quantization = closer to full
// precision; fp8 providers have been observed to emit malformed JSON with
// stray whitespace on batch outputs).
const PROVIDER_PIN = { only: ["deepseek", "alibaba"] };
const model = openrouter(process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-flash", {
  extraBody: { provider: PROVIDER_PIN },
});

let totalCost = 0;
let testsRun = 0;
let testsPassed = 0;

async function runTest(name, fn) {
  testsRun++;
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    console.log(`✓ ${name} (${ms}ms)`);
    if (result?.usage) {
      console.log(`  usage: ${JSON.stringify(result.usage)}`);
    }
    testsPassed++;
    return result;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`✗ ${name} (${ms}ms): ${err.message}`);
    if (err.cause) console.log(`  cause: ${err.cause}`);
    return null;
  }
}

// ── Test 1: RESOLUTION_SCHEMA (item_resolver + denial_resolver) ──────
const RESOLUTION_SCHEMA = z.object({
  resolved_items: z.array(z.object({
    item_id: z.string(),
    item_name_canonical: z.string(),
    qty: z.number().int().min(1).default(1),
    confidence: z.number().min(0).max(1),
    matched_phrase: z.string(),
  })),
  unresolved_phrases: z.array(z.string()),
  notes: z.string().optional(),
});

const ITEM_SYS = `You are a precise camera/photo equipment cataloguer for a film-rental business.
Identify which inventory items the Hygglo listing title represents.
RULES:
1. RESPECT MODEL DISAMBIGUATORS. "A7 II" ≠ "A7 III". "FX3" ≠ "FX6".
2. Only return items physically in the title's bundle.
3. If a title item is NOT in inventory, add to unresolved_phrases.
4. QUANTITY: "2x"/"2×" → 2. Default 1.
5. Confidence: 1.0 unambiguous, 0.6-0.9 partial, <0.5 skip.
6. Use the exact item_id supplied.`;

await runTest("item_resolver — single camera", async () => {
  return await generateObject({
    model,
    schema: RESOLUTION_SCHEMA,
    messages: [
      { role: "system", content: ITEM_SYS },
      { role: "user", content:
`INVENTORY (the only items we own):
- item_id: i1 | name: Sony FX3
- item_id: i2 | name: Sony A7 III [camera]
- item_id: i3 | name: Sony 24-70mm GM [lens]
- item_id: i4 | name: DJI RS3 Pro gimbal [grip]

LISTING TITLE:
"Sony FX3 + 24-70 GM full kit"` },
    ],
    maxOutputTokens: 600,
  });
});

await runTest("item_resolver — kit with disambiguator (A7 III vs A7 II)", async () => {
  const r = await generateObject({
    model,
    schema: RESOLUTION_SCHEMA,
    messages: [
      { role: "system", content: ITEM_SYS },
      { role: "user", content:
`INVENTORY (the only items we own):
- item_id: i1 | name: Sony A7 II
- item_id: i2 | name: Sony A7 III
- item_id: i3 | name: Sony A7 IV

LISTING TITLE:
"Sony A7 III body only"` },
    ],
    maxOutputTokens: 600,
  });
  // Must pick i2 (A7 III), NOT i1 (A7 II) or i3 (A7 IV).
  const picked = r.object.resolved_items[0]?.item_id;
  if (picked !== "i2") throw new Error(`expected i2 (A7 III), got ${picked}`);
  return r;
});

await runTest("item_resolver — 2x quantity extraction (with prod post-processing)", async () => {
  const r = await generateObject({
    model,
    schema: RESOLUTION_SCHEMA,
    messages: [
      { role: "system", content: ITEM_SYS },
      { role: "user", content:
`INVENTORY:
- item_id: i1 | name: Nanlite Pavotube
- item_id: i2 | name: Aputure 300X

LISTING TITLE:
"2x Nanlite Pavotube + Aputure 300X"` },
    ],
    maxOutputTokens: 600,
  });
  // Simulate the prod post-processing: qty fallback regex + mergeDuplicateItems.
  const combinedTitle = "2x Nanlite Pavotube + Aputure 300X";
  const withBumpedQty = r.object.resolved_items.map((x) => {
    let qty = Math.max(1, Math.floor(x.qty ?? 1));
    if (qty === 1 && x.matched_phrase) {
      const phrase = x.matched_phrase.toLowerCase();
      const idx = combinedTitle.toLowerCase().indexOf(phrase);
      if (idx > 0) {
        const before = combinedTitle.slice(Math.max(0, idx - 8), idx);
        const m = /(\d+)\s*[x×]/i.exec(before);
        if (m) qty = Math.max(qty, parseInt(m[1], 10));
      }
    }
    return { ...x, qty };
  });
  // mergeDuplicateItems (MAX strategy).
  const merged = new Map();
  for (const it of withBumpedQty) {
    const existing = merged.get(it.item_id);
    const qty = Math.max(1, Math.floor(it.qty ?? 1));
    if (!existing) merged.set(it.item_id, { ...it, qty });
    else existing.qty = Math.max(existing.qty, qty);
  }
  const final = Array.from(merged.values());
  const pavo = final.find((x) => x.item_id === "i1");
  if (pavo?.qty !== 2) {
    console.log("  raw LLM:", JSON.stringify(r.object.resolved_items));
    console.log("  after post-process:", JSON.stringify(final));
    throw new Error(`expected qty 2 for Pavotube after post-process, got ${pavo?.qty}`);
  }
  return r;
});

// ── Test 2: BATCH_SCHEMA (canonicalize-denials) ──────────────────────
const BATCH_SCHEMA = z.object({
  results: z.array(z.object({
    index: z.number().int(),
    canonical_product: z.string(),
    brand: z.string(),
    kind: z.string(),
  })),
});

const CANON_SYS = `You normalise camera-rental listing titles into clean canonical product names.
Rules:
1. canonical_product = "<Brand> <Model>" only. Strip kit contents, accessory lists.
2. Preserve disambiguating model number/letter exactly: II vs III, Mk2 vs Mk3.
3. For multi-item kits, pick the HEADLINE item.
4. Output exactly ONE entry per input index. Use the same index supplied.
5. Output strict JSON matching the schema.`;

const NOISY_TITLES = [
  "Sony fx 3 fx3 full frame cinema camera + 70-200 mm f2.8 gmaster g-master gm Tele zoom",
  "Canon EOS R5 mirrorless 8K + RF 24-70mm + battery grip + 128GB CFexpress",
  "DJI RS3 Pro gimbal with focus motor and follow focus",
  "2x Nanlite Pavotube II 6C RGB LED Light Wand",
  "BMPCC 6K Pro Blackmagic Pocket Cinema Camera + Samsung T7 SSD",
];

await runTest("canonicalize-denials — 5 noisy titles", async () => {
  const r = await generateObject({
    model,
    schema: BATCH_SCHEMA,
    messages: [
      { role: "system", content: CANON_SYS },
      { role: "user", content: "Normalise each listing title to its canonical product:\n\n" + NOISY_TITLES.map((t, i) => `[${i}] ${t}`).join("\n") },
    ],
    maxOutputTokens: 2000,
  });
  if (r.object.results.length !== 5) throw new Error(`expected 5 entries, got ${r.object.results.length}`);
  const fx3 = r.object.results[0];
  if (!/Sony FX3/i.test(fx3.canonical_product)) throw new Error(`expected Sony FX3 canonical, got "${fx3.canonical_product}"`);
  console.log("  results:", r.object.results.map((x) => `${x.index}=${x.canonical_product}`).join(", "));
  return r;
});

// ── Test 3: extract-booking-times (text mode + 9-line parser) ───────
const TIMES_INSTRUCTIONS = `You are extracting the FINAL AGREED pickup and return times from a rental equipment chat.

INSTRUCTIONS:
- Find the LAST pickup and return times AGREED by both parties.
- Convert vague times: "morning" = 10:00, "evening" = 19:00, "noon" = 12:00.
- If renter corrected themselves, use the LAST corrected time.

Respond ONLY with these nine lines:
PICKUP_TIME: HH:MM or NONE
PICKUP_DATE: YYYY-MM-DD
PICKUP_METHOD: DELIVERY or COLLECTION or UNKNOWN
RETURN_TIME: HH:MM or NONE
RETURN_DATE: YYYY-MM-DD
RETURN_METHOD: DELIVERY or COLLECTION or UNKNOWN
STATUS: ACTIVE or CANCELLED
CONFIDENCE: HIGH or LOW
NOTES: <any relevant context>`;

const TRANSCRIPT = `Owner (2026-05-15 14:00): Hi, when would you like to pick up?
Renter (2026-05-15 14:05): kan jag hämta kl 19 imorgon istället för 17?
Owner (2026-05-15 14:10): 19:00 imorgon works!
Renter (2026-05-15 14:11): Perfect, and return Sunday morning?
Owner (2026-05-15 14:12): Yes 10am Sunday`;

await runTest("extract-booking-times — Swedish/English mixed", async () => {
  const r = await generateText({
    model,
    prompt: `${TIMES_INSTRUCTIONS}\n\nCurrent date/time: 2026-05-15 14:00 UTC\nEquipment: Sony FX3 + 24-70mm\nRental period: 2026-05-16 to 2026-05-18\n\n=== CONVERSATION ===\n${TRANSCRIPT}\n=== END ===`,
    // Reasoning models burn tokens before visible output. 250 → 800 covers
    // ~500 reasoning tokens + 200 visible (the 9 lines).
    maxOutputTokens: 800,
  });
  const txt = r.text ?? "";
  const pickup = /PICKUP_TIME:\s*(\d{1,2}:\d{2})/.exec(txt);
  if (!pickup || pickup[1] !== "19:00") throw new Error(`expected PICKUP_TIME 19:00, got ${pickup?.[1]} from:\n${txt.slice(0, 300)}`);
  const ret = /RETURN_TIME:\s*(\d{1,2}:\d{2})/.exec(txt);
  if (!ret || ret[1] !== "10:00") throw new Error(`expected RETURN_TIME 10:00, got ${ret?.[1]}`);
  console.log("  output preview:", txt.slice(0, 200).replace(/\n/g, " | "));
  return r;
});

// ── Summary ──────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────");
console.log(`${testsPassed}/${testsRun} tests passed`);
process.exit(testsPassed === testsRun ? 0 : 1);
