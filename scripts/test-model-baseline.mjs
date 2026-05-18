/**
 * Compare DeepSeek vs Grok vs Qwen on the qty-extraction edge case
 * + the failed cases above. Pure curl, no AI SDK.
 */
const OR_KEY = process.env.OPENROUTER_API_KEY;
const XAI_KEY = process.env.XAI_API_KEY;

const MODELS = [
  { id: "deepseek/deepseek-v4-flash", endpoint: "openrouter", provider: { only: ["deepseek", "alibaba"] } },
  { id: "qwen/qwen3.5-flash",          endpoint: "openrouter" },
  { id: "google/gemini-3.1-flash-lite", endpoint: "openrouter" },
  { id: "grok-4.3",                    endpoint: "xai" },
];

const PROMPT_QTY = {
  system: `You are a precise camera/photo equipment cataloguer.
RULES:
1. RESPECT MODEL DISAMBIGUATORS. "A7 II" ≠ "A7 III".
2. Only return items in the title.
3. If a title item is NOT in inventory, add to unresolved_phrases.
4. QUANTITY: extract integer qty. "2x" / "2×" / "(2x)" → qty:2/3/2. Default 1.
5. Confidence: 1.0 unambiguous, 0.6-0.9 partial, <0.5 skip.

Output strict JSON: {resolved_items:[{item_id, item_name_canonical, qty, confidence, matched_phrase}], unresolved_phrases:[]}`,
  user: `INVENTORY:
- item_id: i1 | name: Nanlite Pavotube
- item_id: i2 | name: Aputure 300X

LISTING TITLE:
"2x Nanlite Pavotube + Aputure 300X"`,
};

async function callOpenRouter(modelId, msgs, providerPin) {
  const body = {
    model: modelId,
    messages: msgs,
    max_tokens: 800,
    response_format: { type: "json_object" },
  };
  if (providerPin) body.provider = providerPin;
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  const ms = Date.now() - t0;
  return { ms, content: j.choices?.[0]?.message?.content, usage: j.usage, provider: j.provider, finish: j.choices?.[0]?.finish_reason };
}

async function callXai(modelId, msgs) {
  const body = {
    model: modelId,
    messages: msgs,
    max_tokens: 600,
    response_format: { type: "json_object" },
  };
  const t0 = Date.now();
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  const ms = Date.now() - t0;
  return { ms, content: j.choices?.[0]?.message?.content, usage: j.usage, provider: "xai", finish: j.choices?.[0]?.finish_reason };
}

for (const m of MODELS) {
  process.stdout.write(`[${m.id.padEnd(40)}]`);
  try {
    const r = m.endpoint === "openrouter"
      ? await callOpenRouter(m.id, [{ role: "system", content: PROMPT_QTY.system }, { role: "user", content: PROMPT_QTY.user }], m.provider)
      : await callXai(m.id, [{ role: "system", content: PROMPT_QTY.system }, { role: "user", content: PROMPT_QTY.user }]);
    const c = r.content ?? "";
    let obj;
    try { obj = JSON.parse(c); } catch { obj = null; }
    const pavo = obj?.resolved_items?.find((x) => x.item_id === "i1");
    const aput = obj?.resolved_items?.find((x) => x.item_id === "i2");
    const qty = pavo?.qty;
    const verdict = qty === 2 ? "✓ qty=2" : `✗ qty=${qty}`;
    console.log(` ${r.ms}ms ${(r.provider ?? "").padEnd(12)} ${verdict}  cost=${r.usage?.cost ?? "?"} fin=${r.finish}`);
    if (qty !== 2) console.log(`   raw: ${c?.slice(0, 200)?.replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(` ERROR ${e.message}`);
  }
}
