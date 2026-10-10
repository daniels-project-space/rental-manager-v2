import { it, expect, vi } from "vitest";
import {
  executeNativeSwap,
  nativeSwapSnapshot,
  websiteSwapSnapshot,
} from "./quick_reply_swap";
const old = { item_id: 11, product_id: 22, can_remove: true };
const added = { item_id: 12, product_id: 33, can_remove: true };
const state = (items: any[]) => ({
  ok: true,
  actions: { add_product: true },
  items,
});
function fixture(
  states: any[],
  addResult: any = { status: "sent" },
  removeResults: any[] = [{ status: "sent" }],
) {
  return {
    read: vi.fn().mockImplementation(async () => states.shift()),
    add: vi.fn().mockResolvedValue(addResult),
    remove: vi.fn().mockImplementation(async () => removeResults.shift()),
  };
}
it("adds then verifies before removing the old line", async () => {
  const io = fixture([state([old]), state([old, added]), state([added])]);
  expect(await executeNativeSwap(io, 11, 33)).toEqual({
    ok: true,
    state: "applied",
  });
  expect(io.remove).toHaveBeenCalledExactlyOnceWith(11);
});
it("does not remove when addition is disabled", async () => {
  const io = fixture([{ ...state([old]), actions: { add_product: false } }]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("failed");
  expect(io.add).not.toHaveBeenCalled();
  expect(io.remove).not.toHaveBeenCalled();
});
it("blocks a replacement already on the order", async () => {
  const io = fixture([state([old, added])]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("failed");
  expect(io.add).not.toHaveBeenCalled();
});
it("keeps the original if the new line cannot be proven", async () => {
  const io = fixture([state([old]), state([old])]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("attention");
  expect(io.remove).not.toHaveBeenCalled();
});
it("compensates only its newly added line after a skipped removal", async () => {
  const io = fixture([state([old]), state([old, added])], { status: "sent" }, [
    { status: "skipped" },
    { status: "sent" },
  ]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("failed");
  expect(io.remove.mock.calls).toEqual([[11], [12]]);
});
it("does not blindly compensate an uncertain removal", async () => {
  const io = fixture([state([old]), state([old, added])], { status: "sent" }, [
    { status: "failed" },
  ]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("attention");
  expect(io.remove).toHaveBeenCalledTimes(1);
});
it("does not remove after an uncertain add", async () => {
  const io = fixture([state([old])], { status: "failed" });
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("attention");
  expect(io.remove).not.toHaveBeenCalled();
});
it("requires final verification", async () => {
  const io = fixture([state([old]), state([old, added]), state([old, added])]);
  expect((await executeNativeSwap(io, 11, 33)).state).toBe("attention");
});

it("uses value-based snapshots across JSON key reordering", () => {
  const native = {
    account_slug: "one",
    item_id: 11,
    product_id: 22,
    name: "Camera",
    start: "2030-01-01",
    end: "2030-01-02",
  };
  const reordered = Object.fromEntries(Object.entries(native).reverse());
  expect(nativeSwapSnapshot(native, "33")).toBe(
    nativeSwapSnapshot(reordered, "33"),
  );
  expect(nativeSwapSnapshot({ ...native, account_slug: "two" }, "33")).not.toBe(
    nativeSwapSnapshot(native, "33"),
  );
  const web = { lineIndex: 0, listingId: "fixture", qty: 1, start: 1, end: 2 };
  expect(websiteSwapSnapshot(web)).toBe(
    websiteSwapSnapshot(Object.fromEntries(Object.entries(web).reverse())),
  );
});
