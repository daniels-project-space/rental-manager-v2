import { expect, it } from "vitest";
import { update } from "./settings";
it("invalidates drafts atomically without rewriting unrelated configuration", async () => {
  const row: any = { _id: "settings", draft_epoch: 4, ai_boost_rate: 2, ALLOW_HYGGLO_SEND: false };
  const ctx = { db: { query: () => ({ first: async () => row }), patch: async (_id: string, patch: any) => Object.assign(row, patch) } };
  const invoke = (args: any) => (update as any)._handler(ctx, args);
  expect(await invoke({ invalidate_drafts: true })).toMatchObject({ draft_epoch: 5 });
  expect(await invoke({ invalidate_drafts: true })).toMatchObject({ draft_epoch: 6 });
  expect(row.ai_boost_rate).toBe(2);expect(row.ALLOW_HYGGLO_SEND).toBe(false);
  expect(row.invalidate_drafts).toBeUndefined();
  expect(await invoke({ invalidate_drafts: false })).toMatchObject({ ok: true });
  expect(row.draft_epoch).toBe(6);
  await expect(invoke({ ALLOW_HYGGLO_SEND: true, invalidate_drafts: true })).rejects.toThrow("SAFETY_RAIL");
  expect(row.draft_epoch).toBe(6);
});
