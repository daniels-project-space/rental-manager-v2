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
/**
 * Item names a TOOL returned real "what's included" text for this turn.
 *
 * `itemsWithoutKitData` is built in the route's item loop, before the agent
 * runs, and gates KIT_HALLUCINATION. So an item that had no listing text up
 * front stays on that list even after the agent fetches its kit via
 * get_listing_context — and the guard then withholds the reply for stating what
 * the tool just told it. Same shape as the price and availability faults.
 *
 * Deliberately narrow: it requires a NON-EMPTY kit field, not merely that the
 * tool ran. A fabricated kit list is one of the worst things this bot can send
 * (the renter turns up expecting a charger that isn't coming), so "the tool was
 * called" is not good enough — the tool has to have answered.
 */
export function harvestToolKitItems(steps: unknown): Set<string> {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const KIT_KEY = /^(whats_included|included_with_rental|kit_contents)$/i;
  const NAME_KEY = /^(name|item|item_name|listing_name|title)$/i;

  const scan = (node: unknown): void => {
    if (node == null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) scan(v);
      return;
    }
    const obj = node as Record<string, unknown>;
    let kit = false;
    let name: string | null = null;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "args" || k === "input") continue;
      if (KIT_KEY.test(k)) {
        if (typeof v === "string" && v.trim().length > 2) kit = true;
        if (Array.isArray(v) && v.length > 0) kit = true;
      }
      if (NAME_KEY.test(k) && typeof v === "string" && v.trim()) name = v.trim();
    }
    if (kit && name) found.add(name.toLowerCase());
    for (const [k, v] of Object.entries(obj)) {
      if (k === "args" || k === "input") continue;
      scan(v);
    }
  };

  for (const st of (steps as unknown[]) ?? []) scan(st);
  return found;
}

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
