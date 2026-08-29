/**
 * Collect every price the agent obtained from a TOOL during one turn.
 *
 * This feeds the draft guard's price whitelist: the bot may only quote a figure
 * it can trace back to a tool result, so anything this misses becomes an
 * UNGROUNDED_PRICE block and the renter gets silence instead of an answer.
 *
 * Lives outside the route because the route imports `server-only`, and this is
 * pure enough to deserve tests of its own — it was silently harvesting nothing
 * for long enough that replies were being blocked on turns where lookup_pricing
 * had run three times and returned real numbers.
 */
export function harvestToolPrices(steps: unknown, into: number[]): void {
  const PRICE_KEY = /(price|rate|gbp|per_day|perday|daily|total|min|max)/i;
  const seen = new Set<unknown>();
  const walk = (node: unknown, keyHint = ""): void => {
    if (node == null || seen.has(node)) return;
    if (typeof node === "number") {
      if (PRICE_KEY.test(keyHint) && Number.isFinite(node) && node > 0 && node < 10000)
        into.push(Math.round(node));
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v, keyHint);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k);
  };
  // Walk the WHOLE step, minus the arguments.
  //
  // This used to read `st.toolResults`, a key Mastra's steps do not have — the
  // payload is nested under `payload`, the same shape mismatch that made tool
  // telemetry report every call as "?" until it was fixed. So it harvested
  // nothing, and every price the bot fetched through a tool stayed invisible to
  // the guard. Walking the step generically survives the next shape change too.
  //
  // `args`/`input` are skipped deliberately. Those are what the MODEL sent, so
  // harvesting them would let it launder an invented price into the whitelist
  // by passing it to a tool — the exact thing the guard exists to catch.
  const walkStep = (node: unknown, keyHint = ""): void => {
    if (node == null || typeof node !== "object") return walk(node, keyHint);
    // Shares `seen` with walk so a provider payload that points back at itself
    // terminates instead of recursing forever.
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walkStep(v, keyHint);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "args" || k === "input") continue;
      walkStep(v, k);
    }
  };
  for (const st of (steps as unknown[]) ?? []) walkStep(st);
}
