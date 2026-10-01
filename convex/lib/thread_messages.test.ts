import { describe, expect, it } from "vitest";
import { recentChronological } from "./thread_messages";
describe("conversation history", () => {
  it("keeps the latest forty messages in long threads", () => {
    const history = Array.from({ length: 100 }, (_, n) => ({ id: n, fetched_at: n, hygglo_sent_at: n, _creationTime: n }));
    expect(recentChronological(history, 40).map((m) => m.id)).toEqual(Array.from({ length: 40 }, (_, n) => n + 60));
  });
  it("does not treat a late historical import as the latest inbound", () => {
    const history = [{ id: "new", fetched_at: 100, hygglo_sent_at: 100, _creationTime: 100 }, { id: "old-import", fetched_at: 200, hygglo_sent_at: 1, _creationTime: 200 }];
    expect(recentChronological(history, 1)[0].id).toBe("new");
  });
  it("uses fetched time for legacy rows and stable order for ties", () => {
    const history = [{ id: "later", fetched_at: 100, _creationTime: 20 }, { id: "earlier", fetched_at: 100, _creationTime: 10 }];
    expect(recentChronological(history, 2).map((m) => m.id)).toEqual(["earlier", "later"]);
  });
});
