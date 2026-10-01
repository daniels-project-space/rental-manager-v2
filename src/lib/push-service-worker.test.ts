import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const script = readFileSync("public/sw.js", "utf8");
function worker(store = new Map<string, string>(), active = true) {
  const listeners: Record<string, (event: any) => void> = {};
  const newSub = { endpoint: "https://push.test/new", toJSON: () => ({ keys: { p256dh: "public", auth: "auth" } }) };
  const subscribe = vi.fn().mockResolvedValue(newSub);
  const showNotification = vi.fn(async (_title, options) => {
    if (options.renotify && !options.tag) throw new TypeError("renotify requires tag");
  });
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("vapid") ? { key: "AAAA" } : { active } }));
  const indexedDB = { open: () => {
    const request: any = {};
    const db = { close() {}, transaction: () => {
      const transaction: any = {};
      transaction.objectStore = () => ({ get: (key: string) => operation(key), put: (value: string, key: string) => operation(key, value) });
      function operation(key: string, value?: string) {
        const op: any = {};
        queueMicrotask(() => {
          if (value !== undefined) store.set(key, value);
          op.result = store.get(key);
          op.onsuccess?.();
          queueMicrotask(() => transaction.oncomplete?.());
        });
        return op;
      }
      return transaction;
    } };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
  runInNewContext(script, { self: { addEventListener: (type: string, handler: any) => { listeners[type] = handler; }, registration: { pushManager: { subscribe }, showNotification }, clients: {}, skipWaiting() {} }, indexedDB, fetch, atob, Uint8Array, console });
  const fire = async (type: string, data: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners[type]({ ...data, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  };
  return { fire, fetch, subscribe, showNotification, store };
}
describe("actual push worker lifecycle", () => {
  it("renews in a closed-window worker using persisted previous-endpoint proof", async () => {
    const first = worker();
    await first.fire("message", { data: { type: "push-registration-saved", endpoint: "https://push.test/old" } });
    const restarted = worker(first.store);
    await restarted.fire("pushsubscriptionchange", {});
    const save = restarted.fetch.mock.calls.find(([url]) => url === "/api/push/save") as any;
    expect(JSON.parse(save[1].body)).toMatchObject({ endpoint: "https://push.test/new", previous_endpoint: "https://push.test/old" });
    expect(first.store.get("endpoint")).toBe("https://push.test/new");
  });
  it("uses the browser's supplied replacement and leaves an inactive destination unclaimed", async () => {
    const test = worker(new Map([["endpoint", "https://push.test/old"]]), false);
    await test.fire("pushsubscriptionchange", { oldSubscription: { endpoint: "https://push.test/old" }, newSubscription: { endpoint: "https://push.test/rotated", toJSON: () => ({ keys: { p256dh: "public", auth: "auth" } }) } });
    expect(test.subscribe).not.toHaveBeenCalled();
    expect(test.store.get("endpoint")).toBe("https://push.test/old");
  });
  it("displays untagged/malformed fallback payloads instead of rejecting renotify", async () => {
    const test = worker();
    await test.fire("push", { data: { json() { throw Error("invalid JSON"); }, text: () => "Rental alert" } });
    expect(test.showNotification).toHaveBeenCalledWith("Rental Manager", expect.objectContaining({ body: "Rental alert", renotify: false }));
  });
  it("keeps tagged replacement alerts and their conversation deep link", async () => {
    const test = worker();
    await test.fire("push", { data: { json: () => ({ title: "Rental alert", tag: "renter_message:thread", url: "/?thread=thread" }) } });
    expect(test.showNotification).toHaveBeenCalledWith("Rental alert", expect.objectContaining({ tag: "renter_message:thread", renotify: true, data: { url: "/?thread=thread" } }));
  });
});
