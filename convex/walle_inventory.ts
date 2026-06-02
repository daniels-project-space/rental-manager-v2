/**
 * WallE inventory grounding queries — the missing link between the chat
 * surfaces and the `items` table.
 *
 * WHY (2026-06-02): WallE had 13 metric tools and ZERO that read the items
 * table, so existence / spec / compatibility questions ("do we have a
 * Blackmagic", "is the deck an RX2 or RX3", "will an EF lens fit") were
 * answered from the model's memory — i.e. confabulated. The data to answer
 * them correctly (name, kind, lens_mount, compatibility.lenses, aliases) has
 * been sitting in `items` the whole time. These two read-only queries expose
 * it:
 *
 *   index()  — the compact master-inventory list (active, non-marketing) for
 *              eager injection into the chat prompt. Cheap; answers "do we own
 *              X" without a tool call.
 *   lookup() — fuzzy resolve a free-text item reference to the real rows +
 *              full specs/compatibility, using the v1 resolver
 *              (convex/lib/item_matcher) against the LIVE item names. Returns
 *              ALL brand/model matches (so two BMPCC bodies, or the RX2 *and*
 *              RX3 rows, both surface) rather than a single best guess.
 *
 * READ-ONLY. The items table is ~110 rows, so .collect() is acceptable here
 * (same call shape as items:listActive / knowledge:search). This is NOT the
 * reservations table the CLAUDE.md no-collect rule guards.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  findBestMatch,
  normalizeItemName,
  GENERIC_TOKENS,
} from "./lib/item_matcher";

/**
 * Brand / family synonyms the v1 ALIASES map doesn't carry. Item rows are
 * named by model (e.g. "BMPCC 6K Pro"), but owners ask by brand
 * ("blackmagic"). Applied to the QUERY only — never mutates item_matcher's
 * locked ALIASES. Keep additive and uncontroversial (true synonyms only).
 */
const QUERY_SYNONYMS: Record<string, string> = {
  blackmagic: "bmpcc",
  "black magic": "bmpcc",
  pocket: "bmpcc",
};

/** Normalize + expand brand synonyms on a free-text query. */
function expandQuery(input: string): string {
  let s = ` ${normalizeItemName(input)} `;
  for (const [from, to] of Object.entries(QUERY_SYNONYMS)) {
    s = s.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return s.trim();
}

/**
 * The master inventory index — active, non-marketing items only. One compact
 * record per item; the caller renders it into the prompt so WallE can answer
 * "do we own X" / "is it an RX2 or RX3" straight from context, never denying
 * gear it actually owns. Sorted by kind then name for stable, scannable output.
 */
export const index = query({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    return items
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        name: i.name_canonical,
        kind: i.kind,
        sub_kind: i.sub_kind ?? null,
        qty: i.qty,
        lens_mount: i.lens_mount ?? null,
      }))
      .sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      );
  },
});

/**
 * Fuzzy-resolve a free-text item reference to the real item rows, with full
 * specs + compatibility. Returns EVERY plausible match (token overlap on the
 * canonical name + aliases, plus the v1 resolver's single best pick boosted to
 * the top), so brand questions surface all bodies and duplicate/phantom rows
 * are visible rather than silently collapsed.
 */
export const lookup = query({
  args: {
    query: v.string(),
    include_marketing: v.optional(v.boolean()),
  },
  handler: async (ctx, { query: q, include_marketing }) => {
    const all = await ctx.db.query("items").collect();
    // Never consider archived/inactive rows for "do we have it" answers.
    const live = all.filter(
      (i) => i.status === "active" || i.status === "marketing_only",
    );
    const considered = include_marketing
      ? live
      : live.filter((i) => !i.is_marketing_only);

    // The resolver matches against the canonical MASTER inventory (active,
    // non-marketing) — that is the authoritative "what Daniel owns" set.
    const masterNames = all
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => i.name_canonical);
    const expanded = expandQuery(q);
    const resolvedCanonical =
      findBestMatch(expanded, masterNames) ?? findBestMatch(q, masterNames);

    // Token-overlap scoring against name + aliases (brand-synonym expanded).
    const qTokens = expanded
      .split(" ")
      .filter((t) => t.length >= 2 && !GENERIC_TOKENS.has(t));

    const scored = considered
      .map((i) => {
        const hay = new Set(
          normalizeItemName(
            [i.name_canonical, ...(i.aliases ?? [])].join(" "),
          ).split(" "),
        );
        let score = 0;
        for (const t of qTokens) if (hay.has(t)) score += 1;
        if (resolvedCanonical && i.name_canonical === resolvedCanonical)
          score += 5;
        return { i, score };
      })
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.i.status === "active") - Number(a.i.status === "active") ||
          a.i.name_canonical.localeCompare(b.i.name_canonical),
      );

    const matches = scored.slice(0, 12).map(({ i }) => ({
      name: i.name_canonical,
      kind: i.kind,
      sub_kind: i.sub_kind ?? null,
      qty: i.qty,
      status: i.status,
      is_marketing_only: i.is_marketing_only,
      lens_mount: i.lens_mount ?? null,
      battery_type: i.battery_type ?? null,
      card_type: i.card_type ?? null,
      compatibility: i.compatibility ?? null,
      notes: i.notes ?? null,
    }));

    return {
      query: q,
      resolved_canonical: resolvedCanonical,
      match_count: matches.length,
      matches,
    };
  },
});
