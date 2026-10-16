import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { NotifEventInput } from "../notifications";
import { accountWord, isGenuinelyConfirmedBooking } from "./notification_events";
import { confirmedClock, londonStockInstant, londonStockLabel } from "./confirmed_schedule";

type Rental = Partial<Doc<"reservations">>;
const date = (value?: string | null) => value && /^\d{4}-\d\d-\d\d$/.test(value) ? value : undefined;
const endpoint = (r: Rental, kind: "pickup" | "return") => {
  const day=date(kind === "pickup" ? r.pickup_date ?? r.start_date : r.return_date ?? r.end_date);
  return {date:day,time:day?confirmedClock(r,kind,day):undefined};
};
const active = (r: Rental) => !!r.hygglo_order_id && !r.is_obsolete && !["cancelled", "completed"].includes(r.status ?? "") && !["CANCELED", "RETURNED", "REVIEWED", "VERIFICATION_FAILED"].includes(r.order_step ?? "");
const label = (s: ReturnType<typeof endpoint>) => [s.date, s.time].filter(Boolean).join(" · ");
function eventBase(r: Rental) {
  const thread = r.account_slug === "dbcinema_web" ? `dbcinema:${r.hygglo_order_id}` : r.hygglo_order_id!;
  const item = (r.items ?? []).map(i => i.item_name).filter(Boolean).join(" + ") || "Rental";
  return { thread_id: thread, account_slug: r.account_slug,
    body: [item, r.renter_name, accountWord(r.account_slug)].filter(Boolean).join(" · "),
    url: `/?thread=${encodeURIComponent(thread)}${r.account_slug ? `&account=${encodeURIComponent(r.account_slug)}` : ""}` };
}

/** Persisted rental clocks only: no midnight/default clock invented for missing times. */
export function pickupReminderSchedule(r: Rental): { local: string; at: number } | null {
  if (!active(r) || r.order_step === "DELIVERED" || !isGenuinelyConfirmedBooking(r.order_step, r.status)) return null;
  const s = endpoint(r, "pickup");
  if (!s.date || !s.time) return null;
  const local = `${s.date}T${s.time}`;
  let at: number;
  try { at = londonStockInstant(local, "start"); } catch { return null; }
  // Do not interpret a nonexistent DST clock as the start of the day.
  if (londonStockLabel(at) !== local) return null;
  return { local, at };
}

/** A small projection changes only when a rental's actual schedule changes. */
export async function syncPickupReminder(ctx: MutationCtx, r: Rental) {
  if (!r._id) return;
  const previous = await ctx.db.query("rental_pickup_reminders").withIndex("by_reservation", q => q.eq("reservation_id", r._id!)).first();
  const schedule = pickupReminderSchedule(r);
  if (!schedule || schedule.at <= Date.now()) {
    if (previous?.active) await ctx.db.patch(previous._id, { active: false });
    return;
  }
  if (previous?.active && previous.pickup_at === schedule.at && previous.schedule_key === schedule.local) return;
  const fields = { reservation_id: r._id, pickup_at: schedule.at, due_at: schedule.at - 15 * 60_000, schedule_key: schedule.local, active: true };
  if (previous) await ctx.db.patch(previous._id, fields);
  else await ctx.db.insert("rental_pickup_reminders", fields);
}

export function pickupReminderEvent(r: Rental, now: number): NotifEventInput | null {
  const schedule = pickupReminderSchedule(r);
  if (!schedule || now < schedule.at - 15 * 60_000 || now >= schedule.at - 14 * 60_000) return null;
  const { local } = schedule, s = endpoint(r, "pickup");
  const base = eventBase(r);
  return { ...base, type: "pickup_reminder", source_kind: "pickup_15_minutes",
    event_key: `pickup15:${r.account_slug}:${r.hygglo_order_id}:${local}`,
    title: "You have a pickup in 15 minutes", body: `${base.body} · Pickup ${label(s)}` };
}

/** A first import or newly learned clock is not a changed agreement. */
export function rentalTimeChangedEvent(before: Rental, after: Rental, now: number, requireConfirmedClock = false): NotifEventInput | null {
  if (!active(after)) return null;
  const changes = (["pickup", "return"] as const).flatMap(kind => {
    const old = endpoint(before, kind), next = endpoint(after, kind);
    if (requireConfirmedClock && !next.time) return [];
    const changed = !!old.date && !!next.date && (old.date !== next.date || !!old.time && !!next.time && old.time !== next.time);
    return changed ? [{ kind, old, next }] : [];
  });
  if (!changes.length) return null;
  const today = londonStockLabel(now).slice(0, 10);
  if ((endpoint(after, "return").date ?? endpoint(after, "pickup").date ?? "") < today) return null;
  const base = eventBase(after), first = changes[0];
  return { ...base, type: "rental_time_changed", source_kind: "rental_schedule_changed",
    event_key: `schedule:${after.account_slug}:${after.hygglo_order_id}:${now}:${JSON.stringify(changes)}`,
    title: `Your rental changed its time to ${first.next.time ?? first.next.date}`,
    body: `${base.body} · ${changes.map(c => `${c.kind === "pickup" ? "Pickup" : "Return"}: ${label(c.old)} → ${label(c.next)}`).join(" · ")}` };
}
