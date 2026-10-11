import { describe, expect, it, vi } from "vitest";
import { searchMessageHistory } from "./message-history-search";
const request = (id: string) => ({
  thread_id: id,
  terms: ["pickup"],
  cursor: null,
});
describe("message history pagination controller", () => {
  it("continues other conversations after a source fails and retains retry feedback", async () => {
    const progress = vi.fn();
    const read = vi.fn(async ({ requests }: any) => ({
      results: requests.map((r: any) => ({
        thread_id: r.thread_id,
        remaining:
          r.thread_id === "web" ? ["pickup"] : r.cursor ? [] : ["pickup"],
        done: r.thread_id === "web" || !!r.cursor,
        cursor: r.thread_id === "web" || r.cursor ? null : "next",
        scanned: 1,
        ...(r.thread_id === "web" ? { error: "Website unavailable" } : {}),
      })),
    }));
    await searchMessageHistory(
      [request("web"), request("native")],
      read,
      progress,
      () => false,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(
      ["native"],
      false,
      "Website unavailable",
    );
  });
  it("bounds batches and carries only unresolved words into later pages", async () => {
    const read = vi.fn(async ({ requests }: any) => ({
      results: requests.map((r: any) => ({
        thread_id: r.thread_id,
        remaining: r.thread_id === "slow" && !r.cursor ? ["pickup"] : [],
        done: r.thread_id !== "slow" || !!r.cursor,
        cursor: r.thread_id === "slow" && !r.cursor ? "next" : null,
        scanned: 1,
      })),
    }));
    const progress = vi.fn();
    await searchMessageHistory(
      [
        request("slow"),
        ...Array.from({ length: 32 }, (_, i) => request(String(i))),
      ],
      read,
      progress,
      () => false,
    );
    expect(read.mock.calls.every(([a]: any) => a.requests.length <= 16)).toBe(
      true,
    );
    expect(read.mock.calls[1][0].requests[0].thread_id).toBe("15");
    expect(progress.mock.calls.at(-1)[0]).toHaveLength(33);
    expect(progress.mock.calls.at(-1)[1]).toBe(false);
  });
  it("ignores a cancelled response and starts no additional pages", async () => {
    let cancelled = false;
    const read = vi.fn(async () => {
      cancelled = true;
      return { results: [] };
    });
    const progress = vi.fn();
    await searchMessageHistory([request("a")], read, progress, () => cancelled);
    expect(read).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });
  it("stops permanent errors and refuses a stuck or incomplete cursor", async () => {
    const progress = vi.fn();
    const read = vi.fn(async () => {
      throw Error("Unauthorized");
    });
    await expect(
      searchMessageHistory([request("a")], read, progress, () => false),
    ).rejects.toThrow("Unauthorized");
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      searchMessageHistory(
        [request("a")],
        async () => ({
          results: [
            {
              thread_id: "a",
              remaining: ["pickup"],
              done: false,
              cursor: null,
              scanned: 0,
            },
          ],
        }),
        progress,
        () => false,
      ),
    ).rejects.toThrow("advance");
    await expect(
      searchMessageHistory(
        [request("a")],
        async () => ({ results: [] }),
        progress,
        () => false,
      ),
    ).rejects.toThrow("incomplete");
  });
});
