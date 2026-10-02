import { describe, expect, it, vi } from "vitest";
import { setDraftReview, setDraft, threadsNeedingDraft } from "./replyInbox";
import { generateDraft } from "./replyInbox_actions";
import { draftContextKey } from "./lib/draft_review";

// Registered handlers, with an in-memory adapter. Managed persistence is checked separately in the Lab.
function database() {
  const rows = new Map<string, any>(); let serial = 0;
  const db = {
    insert: async (table: string, value: any) => { const id = `${table}:${++serial}`; rows.set(id, { ...value, _id: id, _creationTime: serial, table }); return id; },
    patch: async (id: string, value: any) => { const row = { ...rows.get(id) }; for (const [k, v] of Object.entries(value)) { if (v === undefined) delete row[k]; else row[k] = v; } rows.set(id, row); },
    query: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      const chain: any = { eq: (key: string, value: any) => { filters.push(r => r[key] === value); return chain; }, gte: (key: string, value: any) => { filters.push(r => r[key] >= value); return chain; } };
      const query: any = { withIndex: (_name: string, select: any) => { select(chain); return query; },
        collect: async () => [...rows.values()].filter(r => r.table === table && filters.every(f => f(r))),
        first: async () => (await query.collect())[0] ?? null };
      return query;
    },
  };
  return { ctx: { db }, rows };
}
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
async function setup() {
  const fixture = database(); const { db } = fixture.ctx; const now = Date.now(); const thread_id = "review-test";
  const convId = await db.insert("conversations", { thread_id, last_sender: "renter", last_msg_at: now, last_renter_msg_at: now, ai_draft_text: "Old preview" });
  const settingsId = await db.insert("settings", { draft_epoch: 2 });
  await db.insert("hygglo_messages", { thread_id, message_id: "renter-1", fetched_at: now, hygglo_sent_at: now });
  const booking = { hygglo_order_id: thread_id, start_date: "2026-10-02", end_date: "2026-10-04", status: "PENDING", items: [{ name: "Sony FX3", qty: 1 }] };
  const bookingId = await db.insert("reservations", booking);
  const args = { thread_id, message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking), stage: "INQUIRY", reason: "needs_human:guard_blocked",
    flags: [{ type: "KIT_HALLUCINATION", detail: "Unverified charger", severity: "critical", action: "flagged" }] };
  return { ...fixture, args, convId, settingsId, bookingId, now };
}
describe("durable review mutations and automatic queue", () => {
  it("regenerates a saved draft when its booking becomes obsolete without a new message", async () => {
    const f=await setup();
    expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"Helpful answer"})).toMatchObject({ok:true});
    expect(f.rows.get(f.convId).ai_draft_context_key).toBe(f.args.context_key);
    expect(await invoke(threadsNeedingDraft,f.ctx,{limit:20})).toEqual([]);
    await f.ctx.db.patch(f.bookingId,{is_obsolete:true});
    expect(await invoke(threadsNeedingDraft,f.ctx,{limit:20})).toEqual([f.args.thread_id]);
    expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"Late old answer"})).toMatchObject({ok:false,reason:"stale_context"});
  });
  it("persists reasons, clears the old preview and stops repeated backfill selection", async () => {
    const f = await setup();
    expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([f.args.thread_id]);
    const result = await invoke(setDraftReview, f.ctx, f.args);
    expect(result).toMatchObject({ ok: true, review: { reason: f.args.reason, flags: f.args.flags } });
    expect(f.rows.get(f.convId).ai_draft_text).toBeUndefined();
    for (let n = 0; n < 3; n++) expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([]);
  });
  it("refuses a late blocked result after a new renter message", async () => {
    const f = await setup();
    await f.ctx.db.insert("hygglo_messages", { thread_id: f.args.thread_id, message_id: "renter-2", fetched_at: f.now + 1, hygglo_sent_at: f.now + 1 });
    expect(await invoke(setDraftReview, f.ctx, f.args)).toMatchObject({ ok: false, reason: "stale_inbound" });
    expect(f.rows.get(f.convId).ai_draft_text).toBe("Old preview");
  });
  it("rejects results computed before an order or draft epoch change", async () => {
    for (const target of ["order", "epoch"]) {
      const f = await setup();
      await f.ctx.db.patch(target === "order" ? f.bookingId : f.settingsId, target === "order" ? { end_date: "2026-10-05" } : { draft_epoch: 3 });
      expect(await invoke(setDraftReview, f.ctx, f.args)).toMatchObject({ ok: false });
      expect(await invoke(setDraft, f.ctx, { thread_id: f.args.thread_id, message_id: f.args.message_id, draft_text: "Stale preview", epoch: f.args.epoch, context_key: f.args.context_key })).toMatchObject({ ok: false });
    }
  });
  it("makes changed inbound, order facts and logic eligible again", async () => {
    for (const change of ["inbound", "order", "epoch"]) {
      const f = await setup(); await invoke(setDraftReview, f.ctx, f.args);
      if (change === "inbound") await f.ctx.db.insert("hygglo_messages", { thread_id: f.args.thread_id, message_id: "renter-2", fetched_at: f.now + 1, hygglo_sent_at: f.now + 1 });
      if (change === "order") await f.ctx.db.patch(f.bookingId, { items: [{ name: "Sony FX3", qty: 2 }] });
      if (change === "epoch") await f.ctx.db.patch(f.settingsId, { draft_epoch: 3 });
      expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([f.args.thread_id]);
    }
  });
  it("clears the review only when a current successful draft is saved", async () => {
    const f = await setup(); await invoke(setDraftReview, f.ctx, f.args);
    expect(await invoke(setDraft, f.ctx, { thread_id: f.args.thread_id, message_id: f.args.message_id, epoch: 2, context_key: f.args.context_key, draft_text: "Verified reply" })).toMatchObject({ ok: true });
    expect(f.rows.get(f.convId).ai_draft_review).toBeUndefined();
    expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([]);
  });
  it("returns the saved review on another generation call without invoking a model", async () => {
    const f = await setup(); const saved = await invoke(setDraftReview, f.ctx, f.args);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider must not be called"));
    const ctx = { runAction: vi.fn().mockResolvedValue({}), runQuery: vi.fn().mockResolvedValue({ draft_review: saved.review, draft_epoch: 2, draft_context_key: f.args.context_key, last_message_id: f.args.message_id }), runMutation: vi.fn() };
    try {
      expect(await invoke(generateDraft, ctx, { thread_id: f.args.thread_id })).toMatchObject({ status: "skipped", review: saved.review, flags: f.args.flags });
      expect(fetchSpy).not.toHaveBeenCalled(); expect(ctx.runMutation).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
