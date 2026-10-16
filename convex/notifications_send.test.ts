import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("web-push",()=>({default:{setVapidDetails:vi.fn(),sendNotification:vi.fn(async()=>({statusCode:201}))}}));
vi.mock("./lib/telegram_convex",()=>({automatedTelegramAlertsEnabled:()=>false}));
import webpush from "web-push";
import { dispatchPending } from "./notifications_send";
import { receive } from "./dbcinema_notifications";
import { readFileSync } from "node:fs";
import vm from "node:vm";
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()});
async function dispatch(type:string,extra:any={}){
 vi.stubEnv("VAPID_PUBLIC_KEY","fixture-public");vi.stubEnv("VAPID_PRIVATE_KEY","fixture-private");
 const row={_id:"fixture-notice",type,thread_id:"fixture-thread",account_slug:"diogo",title:"Fixture alert",body:"Sony FX3",url:"/?thread=fixture-thread",created_at:Date.now(),...extra};
 const runMutation=vi.fn(async(ref:any,args:any)=>getFunctionName(ref)==="notifications:claimPending"?[row]:{delivered:1,retryable:0});
 const modes=["all","my_share","money_only"];
 const ctx={runMutation,runQuery:async()=>modes.map(mode=>({mode,endpoint:`https://${mode}.example.invalid`,p256dh:"fixture",auth:"fixture"})),scheduler:{runAfter:vi.fn()}};
 await(dispatchPending as any)._handler(ctx,{});
 return {calls:vi.mocked(webpush.sendNotification).mock.calls,runMutation};
}
describe("actual notification dispatcher with isolated transports",()=>{
 it.each(["pickup_reminder","return_reminder","rental_time_changed"])("delivers %s only to All notifications",async type=>{
  const {calls}=await dispatch(type);expect(calls).toHaveLength(1);expect(calls[0][0].endpoint).toBe("https://all.example.invalid");
  if(type==="pickup_reminder"||type==="return_reminder")expect(calls[0][2]).toEqual({TTL:60,urgency:"high"});
 });
 it("keeps the item and exact half income in the actual 50% phone payload",async()=>{
  const {calls}=await dispatch("booking_confirmed",{copy_data:{item_name:"Sony FX3",renter_name:"Fixture",net:81,gross:100,currency:"GBP"}});
  expect(calls).toHaveLength(3);
  const share=JSON.parse(String(calls.find(c=>c[0].endpoint==="https://my_share.example.invalid")![1]!));
  expect(share).toMatchObject({title:"🎉 Wohoo, you made £40.50!",body:"Sony FX3 on Diogo · Your 50% share"});
 });
});


const accountCases = [
  ["dbcinema", "Daniel", "/icons/notif-aputure.png"],
  ["leo", "Leo", "/icons/notif-aputure-leo.png"],
  ["diogo", "Diogo", "/icons/notif-aputure-diogo.png"],
  ["dbcinema_web", "DB Cinema Web", "/icons/notif-aputure-dbcinema_web.png"],
] as const;

/** Actual worker source, with no window, document, open client, push service or
 * provider connection. This models delivery after every app window is closed. */
async function displayWithAppClosed(payload: Record<string, unknown>) {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn(async (_title: string, _options: any) => undefined);
  const openWindow = vi.fn(async (_url: string) => undefined);
  const matchAll = vi.fn(async () => []);
  const self = {
    location: { origin: "https://manager.example.invalid" },
    addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; },
    registration: { showNotification },
    clients: { matchAll, openWindow },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, console, URL, Uint8Array, atob });
  let pending: Promise<unknown> = Promise.resolve();
  const waitUntil = (task: Promise<unknown>) => { pending = task; };
  handlers.push({ data: { json: () => payload }, waitUntil });
  await pending;
  expect(showNotification).toHaveBeenCalledOnce();
  expect(showNotification.mock.calls[0][0]).toBe(payload.title);
  const options = (showNotification.mock.calls[0] as unknown as [string, any])[1];
  expect(options.body).toBe(payload.body);
  expect(options.data.url).toBe(payload.url);
  expect(options.icon).toBe(payload.icon);
  expect(options.tag).toBe(payload.tag);
  const close = vi.fn();
  handlers.notificationclick({ notification: { data: options.data, close }, waitUntil });
  await pending;
  expect(close).toHaveBeenCalledOnce();
  expect(matchAll).toHaveBeenCalledOnce();
  expect(openWindow).toHaveBeenCalledWith(payload.url);
}

const scopedEvent = (account: string) => {
  const thread = account === "dbcinema_web" ? "dbcinema:fixture-booking" : `fixture-${account}`;
  return { account_slug: account, thread_id: thread, url: `/?thread=${encodeURIComponent(thread)}&account=${account}` };
};

describe("background phone delivery across every account", () => {
  it("carries a real website income receipt through the receiver, queue, 50% dispatcher and closed-app worker", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "fixture-public"); vi.stubEnv("VAPID_PRIVATE_KEY", "fixture-private");
    const rows: any[] = [];
    const db = {
      insert: async (_table: string, fields: any) => { const row = { ...fields, _id: "fixture-event" }; rows.push(row); return row._id; },
      query: (_table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        const selector: any = { eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return selector; } };
        const q: any = { withIndex: (_index: string, select: any) => { select(selector); return q; }, order: () => q, first: async () => rows.find(row => filters.every(filter => filter(row))) ?? null };
        return q;
      },
    };
    const scheduler = { runAfter: vi.fn() };
    const receipt = { version: 1 as const, eventKey: "paid:background-fixture", kind: "booking_paid", conversationId: "background-fixture", createdAt: Date.now(), title: "Paid", body: "Rental paid", renterName: "Fixture", itemName: "Sony FX3", income: { gross: 120, net: 100, currency: "GBP" } };
    const receiver = (receive as any)._handler;
    await receiver({ db, scheduler }, { event: receipt });
    await receiver({ db, scheduler }, { event: receipt });
    expect(rows).toHaveLength(1); expect(scheduler.runAfter).toHaveBeenCalledOnce();
    const ctx = {
      scheduler,
      runQuery: async () => [{ mode: "my_share", endpoint: "https://selected-phone.example.invalid", p256dh: "fixture", auth: "fixture" }],
      runMutation: async (ref: any) => getFunctionName(ref) === "notifications:claimPending" ? rows : { delivered: 1, retryable: 0 },
    };
    await (dispatchPending as any)._handler(ctx, {});
    const calls = vi.mocked(webpush.sendNotification).mock.calls;
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(calls[0][1]));
    expect(payload).toMatchObject({ title: "🎉 Wohoo, you made £50!", body: "Sony FX3 on DB Cinema Web · Your 50% share", url: "/?thread=dbcinema%3Abackground-fixture&account=dbcinema_web", icon: "/icons/notif-aputure-dbcinema_web.png" });
    await displayWithAppClosed(payload);
  });

  it.each(accountCases)("shows %s income at exactly 50%% with the app closed", async (account, label, icon) => {
    const scope = scopedEvent(account);
    const { calls } = await dispatch("booking_confirmed", { ...scope, copy_data: { item_name: "Sony FX3", renter_name: "Fixture", net: 81, gross: 100, currency: "GBP" } });
    const phone = calls.find(call => call[0].endpoint === "https://my_share.example.invalid")!;
    expect(phone).toBeDefined();
    const payload = JSON.parse(String(phone[1]));
    expect(payload).toMatchObject({ title: "🎉 Wohoo, you made £40.50!", body: expect.stringContaining("Sony FX3"), url: scope.url, icon });
    expect(payload.body).toContain("Your 50% share");
    // Account display words may use a personal account's full name.
    expect(payload.body.toLowerCase()).toContain(label.toLowerCase().split(" ")[0]);
    await displayWithAppClosed(payload);
  });

  it.each(accountCases.flatMap(([account, , icon]) => ["pickup_reminder", "return_reminder", "rental_time_changed"].map(type => [account, type, icon] as const)))
    ("delivers %s / %s to All in the background, excludes both income-only lanes", async (account, type, icon) => {
      const scope = scopedEvent(account);
      const { calls } = await dispatch(type, scope);
      expect(calls).toHaveLength(1);
      expect(calls[0][0].endpoint).toBe("https://all.example.invalid");
      const payload = JSON.parse(String(calls[0][1]));
      expect(payload).toMatchObject({ url: scope.url, icon, tag: `${type}:${scope.thread_id}` });
      await displayWithAppClosed(payload);
    });

  it.each(accountCases)("does not turn %s messages, changes, cancellation, support or emails into income pushes", async account => {
    for (const type of ["new_request", "renter_message", "low_response_rate", "human_request", "booking_cancelled", "email_notification", "booking_update"]) {
      vi.mocked(webpush.sendNotification).mockClear();
      // Even an accidental copy_data value cannot admit a non-income type.
      const { calls } = await dispatch(type, { ...scopedEvent(account), copy_data: { net: 100, item_name: "Fixture" } });
      expect(calls).toHaveLength(1);
      expect(calls[0][0].endpoint).toBe("https://all.example.invalid");
    }
  });

  it.each(accountCases)("does not push zero or missing %s income to My 50%%", async account => {
    for (const copy_data of [undefined, { net: 0, gross: 100 }, { net: -1, gross: 100 }]) {
      vi.mocked(webpush.sendNotification).mockClear();
      const { calls } = await dispatch("booking_confirmed", { ...scopedEvent(account), copy_data });
      expect(calls).toHaveLength(1);
      expect(calls[0][0].endpoint).toBe("https://all.example.invalid");
    }
  });
});
