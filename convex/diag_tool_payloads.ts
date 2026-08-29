import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";

/**
 * How big is each tool's RESULT, in characters?
 *
 * Sweep telemetry shows the prompt growing ~9K tokens per tool call — 8K at
 * zero calls, 84K at nine. Mastra re-sends the whole accumulated context on
 * every step, so an oversized tool result is not paid once: it is paid again on
 * each subsequent step, and it pushes the turn toward the model's slow path.
 * Cost is masked by an 80% cache hit rate, but latency is not, and neither is
 * the risk of crowding out the fact pack.
 *
 * search_knowledge is the most-called tool (287 of 629 calls) purely because
 * the prompt says "when unsure → query", so its payload size matters most.
 *
 * Measures each tool against a real listing rather than guessing.
 */
export default internalAction({
  handler: async (ctx): Promise<unknown> => {
    const size = (v: unknown) => {
      try {
        return JSON.stringify(v ?? null).length;
      } catch {
        return -1;
      }
    };
    const out: Record<string, { chars: number; approxTokens: number; note?: string }> = {};
    const rec = (k: string, v: unknown, note?: string) => {
      const c = size(v);
      out[k] = { chars: c, approxTokens: Math.round(c / 4), ...(note ? { note } : {}) };
    };

    const item = "Blackmagic BMPCC 6K Pro";
    const acct = "leo";

    try {
      rec(
        "search_knowledge(what's included)",
        await ctx.runQuery(api.knowledge.search, {
          query: "what is included with the camera",
        }),
      );
    } catch (e) {
      rec("search_knowledge", String(e).slice(0, 120));
    }

    try {
      rec(
        "lookup_pricing",
        await ctx.runQuery(api.renter_bot_tools.lookup_pricing, {
          item_name: item,
          account_slug: acct,
          days: 3,
        }),
      );
    } catch (e) {
      rec("lookup_pricing", String(e).slice(0, 120));
    }

    try {
      rec(
        "find_owned_alternatives(camera)",
        await ctx.runQuery(api.renter_bot_tools.find_owned_alternatives, {
          account_slug: acct,
          kind: "camera",
        }),
      );
    } catch (e) {
      rec("find_owned_alternatives", String(e).slice(0, 120));
    }

    return {
      note: "chars of the JSON the agent gets back; ~4 chars per token",
      payloads: out,
    };
  },
});
