import { expect, it } from "vitest";
import { repairLegacyKitSources } from "./kit_source_repair";
import { DEFAULT_HARD_TRUTHS, LEGACY_HARD_TRUTHS } from "./hard_truths";

it("repairs exact legacy sources, preserves owner edits, supports dry run and is idempotent", async () => {
  const oldFAQ = "This kit does NOT include an SSD — that's the 6K Pro variant only. The Full Frame kit is a Canon EF-to-L mount adapter + 5× LP-E6NH batteries plus charger. Answer confidently from these two facts; there is nothing else confirmed in this kit.";
  const tables: Record<string, any[]> = {
    settings: [{ _id: "settings", draft_epoch: 4 }],
    account_profiles: [{ _id: "default", hard_truths: LEGACY_HARD_TRUTHS }, { _id: "custom", hard_truths: "My charger policy" }],
    memories: [{ _id: "old", title: "FAQ: BMPCC 6K Full Frame Storage", content: oldFAQ },
      { _id: "edited", title: "FAQ: BMPCC 6K Full Frame Storage", content: "Owner updated kit" }],
  };
  const ctx = { db: { query: (table: string) => ({ collect: async () => tables[table], first: async () => tables[table][0] ?? null }),
    patch: async (id: string, value: any) => Object.assign(Object.values(tables).flat().find(r => r._id === id), value) } };
  const invoke = (apply: boolean) => (repairLegacyKitSources as any)._handler(ctx, { apply });
  expect(await invoke(false)).toMatchObject({ profiles: 1, memories: ["FAQ: BMPCC 6K Full Frame Storage"] });
  expect(tables.memories[0].content).toBe(oldFAQ);
  expect(tables.settings[0].draft_epoch).toBe(4);
  expect(await invoke(true)).toMatchObject({ profiles: 1 });
  expect(tables.account_profiles[0].hard_truths).toBe(DEFAULT_HARD_TRUTHS);
  expect(tables.account_profiles[1].hard_truths).toBe("My charger policy");
  expect(tables.memories[0].content).toContain("1TB CFexpress Type B");
  expect(tables.memories[0].content).toContain("NP-F570");
  expect(tables.memories[1].content).toBe("Owner updated kit");
  expect(tables.settings[0].draft_epoch).toBe(5);
  expect(await invoke(true)).toMatchObject({ profiles: 0, memories: [] });
  expect(tables.settings[0].draft_epoch).toBe(5);
});
