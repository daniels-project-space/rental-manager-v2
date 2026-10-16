import { describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { loadReplyTileMessages } from "./replyInbox";
import { orderedReplyMessages } from "./lib/reply_message_order";
import { readOnlineListing } from "./lib/online_listing_read";
import type { QueryCtx } from "./_generated/server";

type Message = { _id: string; _creationTime: number; thread_id: string; message_id: string; fetched_at: number; hygglo_sent_at?: number; text: string };
function messagesDb(rows: Message[]) {
  const calls: string[] = [];
  const ctx = { db: { query: () => {
    let index = "", thread = "";
    const query = {
      withIndex(name: string, build: (q: unknown) => unknown) {
        index = name; const filter = { eq: (_field: string, value: string) => { thread = value; return filter; } }; build(filter); return query;
      },
      order: () => query,
      take: async (limit: number) => {
        calls.push(index);
        return rows.filter(row => row.thread_id === thread).sort((a, b) =>
          (index === "by_thread_and_sent_at" ? (b.hygglo_sent_at ?? -Infinity) - (a.hygglo_sent_at ?? -Infinity) : 0) || b._creationTime - a._creationTime,
        ).slice(0, limit);
      },
    }; return query;
  } } } as unknown as QueryCtx;
  return { ctx, calls };
}
async function original(ctx: QueryCtx) {
  const pages = await Promise.all([
    ctx.db.query("hygglo_messages").withIndex("by_thread_and_sent_at", q => q.eq("thread_id", "thread")).order("desc").take(40),
    ctx.db.query("hygglo_messages").withIndex("by_thread", q => q.eq("thread_id", "thread")).order("desc").take(40),
  ]);
  return orderedReplyMessages([...new Map(pages.flat().map(message => [message.message_id, message])).values()]).slice(0, 40);
}
const transcript = (count: number, duplicate = false): Message[] => Array.from({ length: count }, (_, i) => ({
  _id: `row-${i}`, _creationTime: 1000 + i, thread_id: "thread", message_id: duplicate && i < 3 ? "duplicate" : `message-${i}`,
  fetched_at: 50_000 - i * 17, ...(i % 4 ? { hygglo_sent_at: 20_000 + i % 7 } : {}), text: `exact text ${i}`,
}));

describe("bounded reply message reads", () => {
  it.each([0, 1, 12, 39, 40, 41, 85])("preserves the original transcript at %i records, including missing timestamps and backfills", async count => {
    const rows = [...transcript(count), { ...transcript(1)[0], _id: "other", thread_id: "other" }];
    const actual = messagesDb(rows), baseline = messagesDb(rows);
    expect(await loadReplyTileMessages(actual.ctx, "thread")).toEqual(await original(baseline.ctx));
    expect(actual.calls).toEqual(count < 40 ? ["by_thread_and_sent_at"] : ["by_thread_and_sent_at", "by_thread"]);
  });
  it("retains creation-index precedence for duplicate provider message IDs", async () => {
    const actual = messagesDb(transcript(12, true)), baseline = messagesDb(transcript(12, true));
    expect(await loadReplyTileMessages(actual.ctx, "thread")).toEqual(await original(baseline.ctx));
    expect(actual.calls).toHaveLength(2);
  });
});

describe("request scoped online listing reads", () => {
  function fixture() {
    const first = vi.fn(async () => ({ _id: "listing", name: "Exact model", photos: ["original"] }));
    const db = { query: () => ({ withIndex: (_name: string, build: (q: unknown) => unknown) => {
      const filter = { eq: () => filter }; build(filter); return { first };
    } }) };
    return { db, first, ctx: { db } as unknown as QueryCtx };
  }
  it("coalesces concurrent exact reads and returns independent full documents", async () => {
    const { ctx, first } = fixture();
    const [a, b] = await Promise.all([readOnlineListing(ctx, "owner", 1), readOnlineListing(ctx, "owner", 1)]);
    expect(a).toEqual(b); expect(first).toHaveBeenCalledTimes(1);
    (a as unknown as { photos: string[] }).photos.push("changed");
    expect(b).toHaveProperty("photos", ["original"]);
  });
  it("keeps account/product keys and separate query snapshots isolated", async () => {
    const { ctx, first, db } = fixture();
    await readOnlineListing(ctx, "owner", 1); await readOnlineListing(ctx, "other", 1); await readOnlineListing(ctx, "owner", 2);
    await readOnlineListing({ db } as unknown as QueryCtx, "owner", 1);
    expect(first).toHaveBeenCalledTimes(4);
  });
  it("memoizes exact misses within the query", async () => {
    const { ctx, first } = fixture(); first.mockResolvedValueOnce(null as never);
    expect(await readOnlineListing(ctx, "owner", 1)).toBeNull(); expect(await readOnlineListing(ctx, "owner", 1)).toBeNull();
    expect(first).toHaveBeenCalledTimes(1);
  });
});
