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
 * Focus type — derived, never stored. The chat kept GUESSING which lenses
 * autofocus (the "everything he says is wrong" complaint) because no field
 * carried it. We classify deterministically: trust the hand-written /
 * grok-generated item_specs prose FIRST (it literally says "Linear motor AF" /
 * "manual focus"), then fall back to unambiguous brand/family heuristics, and
 * return null when genuinely unsure so the chat says "not certain" instead of
 * inventing. Cine/anamorphic glass (Blazar, DZOFilm Vespid, Great Joy) is
 * manual; native Sony E and Canon EF still photo zooms autofocus; fixed-lens
 * action cams (GoPro, Osmo) are "fixed".
 */
export function classifyFocus(
  name: string,
  kind: string | undefined,
  specText: string | undefined,
): "autofocus" | "manual_focus" | null {
  // Focus is a LENS property. Gate here so a name token never leaks a focus tag
  // onto non-glass — e.g. a Sirui *tripod* was matching the Sirui-anamorphic
  // heuristic and getting a bogus "manual focus" tag in the inventory index.
  if (kind !== "lens") return null;
  const n = (name ?? "").toLowerCase();
  const s = (specText ?? "").toLowerCase();
  // 1) Spec prose is authoritative when it speaks plainly.
  if (/\b(manual[- ]?focus|manual focus only|no autofocus|de-?clicked|cine prime|focus by hand|manual iris)\b/.test(s))
    return "manual_focus";
  if (/\b(autofocus|auto-?focus|\baf\b|linear motor|stepping motor|\bxd\b linear|eye[- ]?af|subject[- ]?detect|phase[- ]?detect|fast hybrid af)\b/.test(s))
    return "autofocus";
  // 2) Family heuristics on the name (only the unambiguous ones).
  if (/\b(anamorphic|blazar|remus|dzofilm|vespid|great joy|samyang|rokinon|laowa|irix|7artisans|sirui|tokina cine|cine prime)\b/.test(n))
    return "manual_focus";
  // Native AF still-photo systems we own: Sony E (GM / FE / SEL) and Canon EF.
  if (/\b(sony|gm|fe|sel|canon ef|ef-?s|sigma|tamron|rf)\b/.test(n))
    return "autofocus";
  return null;
}

/** Compact spec record joined from the item_specs corpus. */
type SpecRec = { description?: string; specs_long?: string };

/** Build name_canonical → spec map from already-collected item_specs rows. */
function buildSpecMap(
  rows: Array<{ item_name_canonical?: string; description?: string; specs_long?: string }>,
): Map<string, SpecRec> {
  const m = new Map<string, SpecRec>();
  for (const r of rows) {
    if (!r.item_name_canonical) continue;
    // First write wins; rows are 1:1 with items in practice.
    if (!m.has(r.item_name_canonical))
      m.set(r.item_name_canonical, { description: r.description, specs_long: r.specs_long });
  }
  return m;
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
    const [items, specRows] = await Promise.all([
      ctx.db.query("items").collect(),
      ctx.db.query("item_specs").collect(),
    ]);
    const specMap = buildSpecMap(specRows);
    return items
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => {
        const spec = specMap.get(i.name_canonical);
        const specText = `${spec?.description ?? ""} ${spec?.specs_long ?? ""}`;
        return {
          name: i.name_canonical,
          kind: i.kind,
          sub_kind: i.sub_kind ?? null,
          qty: i.qty,
          lens_mount: i.lens_mount ?? null,
          // Derived so cross-inventory questions ("which lenses autofocus")
          // answer from the always-injected index, no tool hop, no guessing.
          focus: classifyFocus(i.name_canonical, i.kind, specText),
        };
      })
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
    const [all, specRows] = await Promise.all([
      ctx.db.query("items").collect(),
      ctx.db.query("item_specs").collect(),
    ]);
    const specMap = buildSpecMap(specRows);
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

    const matches = scored.slice(0, 12).map(({ i }) => {
      const spec = specMap.get(i.name_canonical);
      const specText = `${spec?.description ?? ""} ${spec?.specs_long ?? ""}`;
      return {
        name: i.name_canonical,
        kind: i.kind,
        sub_kind: i.sub_kind ?? null,
        qty: i.qty,
        status: i.status,
        is_marketing_only: i.is_marketing_only,
        lens_mount: i.lens_mount ?? null,
        battery_type: i.battery_type ?? null,
        card_type: i.card_type ?? null,
        // Derived AF/MF/fixed classification (see classifyFocus) so spec
        // questions are grounded, not recalled from the model's memory.
        focus: classifyFocus(i.name_canonical, i.kind, specText),
        compatibility: i.compatibility ?? null,
        // The hand-written / grok spec prose — the actual answer source for
        // "specs of the X", focal length, aperture, autofocus, weight, etc.
        // Was sitting unused in item_specs; now surfaced to the chat.
        spec_description: spec?.description ?? null,
        specs_long: spec?.specs_long ?? null,
        notes: i.notes ?? null,
      };
    });

    return {
      query: q,
      resolved_canonical: resolvedCanonical,
      match_count: matches.length,
      matches,
    };
  },
});
