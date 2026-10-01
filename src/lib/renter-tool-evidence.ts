/** Independent receipts from tool RESULTS, never the model's arguments or prose. */
export type ToolReceipt = { tool: string; call_id: string; result: Record<string, unknown> };

export function renterToolReceipts(steps: unknown): ToolReceipt[] {
  const receipts: ToolReceipt[] = [];
  const seen = new Set<unknown>();
  const handledOutputs = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as Record<string, unknown>;
    const payload = (value.payload ?? value) as Record<string, unknown>;
    const output = payload.result ?? payload.output;
    if (typeof payload.toolName === "string" && output && typeof output === "object" && !Array.isArray(output) && !handledOutputs.has(output)) {
      handledOutputs.add(output);
      const result = output as Record<string, unknown>;
      if (!result.error && result.ok !== false && result.found !== false)
        receipts.push({ tool: payload.toolName, call_id: String(payload.toolCallId ?? "unknown"), result });
      if (!result.error && result.ok !== false && result.found !== false && payload.toolName === "find_owned_alternatives" && Array.isArray(result.alternatives)) {
        for (const alternative of result.alternatives) {
          const a = alternative as Record<string, unknown>;
          const stock = a.availability as Record<string, unknown> | null;
          if (stock?.available === true && typeof a.name === "string")
            receipts.push({ tool: "check_availability", call_id: `${String(payload.toolCallId ?? "unknown")}:${a.name}`, result: { ...stock, item_name: a.name, owned: true, requested_units: stock.quantity } });
        }
      }
    }
    for (const [key, child] of Object.entries(value))
      if (!["args", "input", "result", "output"].includes(key)) visit(child);
  };
  visit(steps);
  return receipts;
}

export function availabilityEvidence(receipts: ToolReceipt[]) {
  return receipts.filter((r) => r.tool === "check_availability" &&
    typeof r.result.available === "boolean" &&
    typeof r.result.item_name === "string" &&
    typeof r.result.start_date === "string" &&
    typeof r.result.end_date === "string" &&
    (r.result.available === false || r.result.owned === true));
}

export function successfulGrounding(receipts: ToolReceipt[]) {
  const stock = availabilityEvidence(receipts);
  return {
    availability: stock.some((r) => r.result.available === true),
    unavailability: stock.some((r) => r.result.available === false),
    price: receipts.some((r) => r.tool === "lookup_pricing" && r.result.found === true && typeof r.result.daily_rate_gbp === "number"),
    specs: receipts.some((r) => r.tool === "get_listing_context" && Array.isArray(r.result.items) && r.result.items.length > 0),
  };
}
