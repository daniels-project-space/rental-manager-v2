import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { NotifEventInput } from "../notifications";
import { accountWord, isGenuinelyConfirmedBooking } from "./notification_events";
import { calendarClock, confirmedClock, londonStockInstant, londonStockLabel } from "./confirmed_schedule";
import { isGearOut } from "../order_step_semantics";

type Rental = Partial<Doc<"reservations">>;
const date = (value?: string | null) => value && /^\d{4}-\d\d-\d\d$/.test(value) ? value : undefined;
const endpoint = (r: Rental, kind: "pickup" | "return") => {
  const day=date(kind === "pickup" ? r.pickup_date ?? r.start_date : r.return_date ?? r.end_date);
  return {date:day,time:day?calendarClock(r,kind,day).time ?? undefined:undefined};
};
const active = (r: Rental) => !!r.hygglo_order_id && !r.is_obsolete && !["cancelled", "completed"].includes(r.status ?? "") && r.booking_status !== "returned" && !["CANCELED", "REVIEWED", "VERIFICATION_FAILED"].includes(r.order_step ?? "");
const label = (s: ReturnType<typeof endpoint>) => [s.date, s.time].filter(Boolean).join(" · ");
function eventBase(r: Rental) {
  const thread = r.account_slug === "dbcinema_web" ? `dbcinema:${r.hygglo_order_id}` : r.hygglo_order_id!;
  const names = (r.items ?? []).map(i => i.item_name).filter(Boolean);
  const item = names.slice(0, 2).map(name => name.slice(0, 100)).join(" + ") + (names.length > 2 ? ` + ${names.length - 2} more` : "") || "Rental";
  return { thread_id: thread, account_slug: r.account_slug,
    body: [item, r.renter_name?.slice(0, 80), accountWord(r.account_slug).slice(0, 40)].filter(Boolean).join(" · "),
    url: `/?thread=${encodeURIComponent(thread)}${r.account_slug ? `&account=${encodeURIComponent(r.account_slug)}` : ""}` };
}

export type ReminderKind = "pickup" | "return";

/** Owner reminders follow the calendar's saved clocks. Stock precision still
 * requires corroboration in confirmedClock; no default clock is invented here. */
export function rentalReminderSchedule(r: Rental, kind: ReminderKind): { local: string; at: number } | null {
  if (!active(r) || !isGenuinelyConfirmedBooking(r.order_step, r.status)) return null;
  const collected = isGearOut(r.order_step) || r.account_slug === "dbcinema_web" && r.order_step === "DELIVERED";
  if (kind === "pickup" && collected) return null;
  const s = endpoint(r, kind);
  if (!s.date || !s.time) return null;
  const local = `${s.date}T${s.time}`;
  let at: number;
  try { at = londonStockInstant(local, kind === "pickup" ? "start" : "end"); } catch { return null; }
  if (londonStockLabel(at) !== local) return null;
  return { local, at };
}
export const pickupReminderSchedule = (r: Rental) => rentalReminderSchedule(r, "pickup");

/** At most two indexed projection rows per rental, updated by every source. */
export async function syncRentalReminders(ctx: MutationCtx, r: Rental) {
  if (!r._id) return;
  const saved = await ctx.db.query("rental_pickup_reminders").withIndex("by_reservation", q => q.eq("reservation_id", r._id!)).take(3);
  for (const kind of ["pickup", "return"] as const) {
    const previous = saved.find(row => (row.kind ?? "pickup") === kind);
    const schedule = rentalReminderSchedule(r, kind);
    if (!schedule || schedule.at <= Date.now()) {
      if (previous?.active) await ctx.db.patch(previous._id, { active: false });
      continue;
    }
    if (previous?.fired_schedule_key === schedule.local) {
      if (previous.active) await ctx.db.patch(previous._id, { active: false });
      continue;
    }
    if (previous?.active && (previous.scheduled_at ?? previous.pickup_at) === schedule.at && previous.schedule_key === schedule.local) continue;
    const fields = { reservation_id: r._id, kind, scheduled_at: schedule.at,
      due_at: schedule.at - 15 * 60_000, schedule_key: schedule.local, active: true };
    if (previous) await ctx.db.patch(previous._id, { ...fields, pickup_at: undefined });
    else await ctx.db.insert("rental_pickup_reminders", fields);
  }
}

export function rentalReminderEvent(r: Rental, now: number, kind: ReminderKind): NotifEventInput | null {
  const schedule = rentalReminderSchedule(r, kind);
  // A scheduler running seconds late must not silently lose the alert. Never
  // send an overdue reminder, and refresh its countdown when delivery retries.
  if (!schedule || now < schedule.at - 15 * 60_000 || now >= schedule.at) return null;
  const base = eventBase(r), minutes = Math.ceil((schedule.at - now) / 60_000);
  return { ...base, type: kind === "pickup" ? "pickup_reminder" : "return_reminder", source_kind: `${kind}_15_minutes`,
    event_key: `${kind}15:${r.account_slug}:${r.hygglo_order_id}:${schedule.local}`,
    title: `You have a ${kind} in ${minutes} minute${minutes === 1 ? "" : "s"}`,
    body: `${base.body} · ${kind === "pickup" ? "Pickup" : "Return"} ${label(endpoint(r, kind))}` };
}
export const pickupReminderEvent = (r: Rental, now: number) => rentalReminderEvent(r, now, "pickup");
export const returnReminderEvent = (r: Rental, now: number) => rentalReminderEvent(r, now, "return");

/** A first import or newly learned clock is not a changed agreement. */
export function rentalTimeChangedEvent(before: Rental, after: Rental, now: number, requireConfirmedClock = false): NotifEventInput | null {
  if (!active(after)) return null;
  const changes = (["pickup", "return"] as const).flatMap(kind => {
    const old = endpoint(before, kind), next = endpoint(after, kind);
    if (requireConfirmedClock && (!next.date || !confirmedClock(after, kind, next.date))) return [];
    const changed = !!old.date && !!next.date && (old.date !== next.date || !!old.time && !!next.time && old.time !== next.time);
    return changed ? [{ kind, old, next }] : [];
  });
  if (!changes.length) return null;
  const today = londonStockLabel(now).slice(0, 10);
  if ((endpoint(after, "return").date ?? endpoint(after, "pickup").date ?? "") < today) return null;
  const base = eventBase(after);
  return { ...base, type: "rental_time_changed", source_kind: "rental_schedule_changed",
    event_key: `schedule:${after.account_slug}:${after.hygglo_order_id}:${now}:${JSON.stringify(changes)}`,
    title: `${after.renter_name?.slice(0, 60) || "Your renter"} has changed their rental times to ${changes.map(c => `${c.kind === "pickup" ? "pickup" : "return"} ${c.next.time ?? c.next.date}`).join(" · ")}`,
    body: `${base.body} · ${changes.map(c => `${c.kind === "pickup" ? "Pickup" : "Return"}: ${label(c.old)} → ${label(c.next)}`).join(" · ")}` };
}
