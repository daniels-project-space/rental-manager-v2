// Isolated notifications layered onto the actual Quick Reply fixture transport.
// No backend client, provider credentials or network write is constructed.
import { getFunctionName } from "convex/server";
import { useCallback, useSyncExternalStore } from "react";
import * as base from "./transport";
export { usePaginatedQuery, useConvexAuth } from "./transport";
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => { revision++; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => revision;
const web = base.rows.find(row => row.source === "dbcinema_web")!;
web.thread_id = `dbcinema:${web.source_booking_id}`;
const events = [
  ...[base.rows[2], web].flatMap(row => ["return_reminder", "rental_time_changed"].map(type => ({
    _id: `${type}-${row.thread_id}`, type, thread_id: row.thread_id, account_slug: row.account_slug,
    title: type === "return_reminder" ? "You have a return in 15 minutes" : `${row.renter_name} has changed their rental times to return 18:00`,
    body: `${row.renter_name} · ${row.items[0].name}`, created_at: Date.now(),
    url: `/?keep=1&thread=${encodeURIComponent(row.thread_id)}&account=${encodeURIComponent(row.account_slug)}#quick-reply`,
  }))),
];
(window as any).__notificationFixture = { events, web, changed };
export function useQuery(ref: any, args: any) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const result = base.useQuery(ref, args);
  const name = getFunctionName(ref);
  if (name === "notifications:listRecent") return { events: args.mode === "all" ? events : [], unread: 0 };
  if (name === "notifications:getVapidPublicKey") return null;
  if (name === "notifications:pushRegistrationStatus") return { active: false };
  return result;
}
export const useAction = base.useAction;
export function useMutation(ref: any) {
  const fallback = base.useMutation(ref);
  const name = getFunctionName(ref);
  return useCallback(async (args: any) => {
    if (name === "notifications:markAllRead") return;
    if (name.startsWith("notifications:")) throw Error("Fixture refuses notification sends/registration");
    return fallback(args);
  }, [fallback, name]);
}
