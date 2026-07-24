"use node";
/**
 * Apple Calendar (iCloud CalDAV) integration — network/actions side.
 *
 * Connect once with an Apple ID + an **app-specific password** (appleid.apple.com
 * → Sign-In & Security → App-Specific Passwords). We discover the CalDAV calendar
 * and push each CONFIRMED booking's pickup + return times as events with
 * reminders, updating/removing them when the booking changes. No OAuth exists for
 * iCloud CalDAV — it's Basic auth with the app password. DB layer: calendar_apple_db.
 */
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import crypto from "crypto";

const ICLOUD_ROOT = "https://caldav.icloud.com";
const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const APPLE_VAULT_SERVICE = "apple_calendar";
const ACCOUNT_CALENDAR_NAMES: Record<string, string> = {
  leo: "Leo Rentals",
  diogo: "Arbeit",
  dbcinema: "DB Cinema Rentals",
};

async function getVaultAppleCredentials(): Promise<{ appleId: string; appPassword: string }> {
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const response = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service: APPLE_VAULT_SERVICE, vaultToken },
      format: "json",
    }),
  });
  if (!response.ok) throw new Error(`Apple vault fetch failed: ${response.status}`);
  const data = (await response.json()) as { value?: Array<{ keyName: string; value: string }> };
  const read = (keyName: string) => data.value?.find((row) => row.keyName === keyName)?.value;
  const appleId = read("APPLE_ID");
  const appPassword = read("APPLE_APP_PASSWORD");
  if (!appleId || !appPassword) throw new Error("Apple Calendar credentials are missing from the vault");
  return { appleId, appPassword };
}

type ResForCal = {
  thread_id: string; account_slug: string | null; renter_name: string; items: string[];
  status: string; pickup_date: string | null; pickup_time: string | null;
  return_date: string | null; return_time: string | null; pickup_address: string | null;
};

// ── iCalendar (.ics) + Europe/London wall-clock → UTC ────────────────────────
function londonOffsetMin(utcMs: number): number {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).forEach((p) => (parts[p.type] = p.value));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}
function londonToUtcMs(date: string, time: string): number {
  const [Y, M, D] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  const guess = Date.UTC(Y, (M || 1) - 1, D || 1, h || 0, m || 0);
  return guess - londonOffsetMin(guess) * 60000;
}
function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsEscape(s: string): string {
  return (s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fold(line: string): string {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  let rest = line.slice(74);
  while (rest.length) { out += "\r\n " + rest.slice(0, 73); rest = rest.slice(73); }
  return out;
}
type CalEvent = { uid: string; startMs: number; endMs: number; summary: string; description?: string; location?: string; alarmMin?: number };
function buildVEvent(e: CalEvent, dtstampMs: number): string {
  const lines = [
    "BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${icsUtc(dtstampMs)}`,
    `DTSTART:${icsUtc(e.startMs)}`, `DTEND:${icsUtc(e.endMs)}`, fold(`SUMMARY:${icsEscape(e.summary)}`),
  ];
  if (e.location) lines.push(fold(`LOCATION:${icsEscape(e.location)}`));
  if (e.description) lines.push(fold(`DESCRIPTION:${icsEscape(e.description)}`));
  lines.push("SEQUENCE:0", "STATUS:CONFIRMED", "TRANSP:OPAQUE");
  if (e.alarmMin && e.alarmMin > 0) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${icsEscape(e.summary)}`), `TRIGGER:-PT${Math.round(e.alarmMin)}M`, "END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines.join("\r\n");
}
function buildVCalendar(vevent: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RMv2//Rental Manager//EN", "CALSCALE:GREGORIAN", vevent, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
function sha(s: string): string { return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16); }

function eventsForReservation(r: ResForCal, leadMin: number, returnLeadMin: number): CalEvent[] {
  const label = r.items.slice(0, 2).join(", ") || "rental";
  const out: CalEvent[] = [];
  if (r.pickup_date && r.pickup_time) {
    const start = londonToUtcMs(r.pickup_date, r.pickup_time);
    out.push({
      uid: `rmv2-${r.thread_id}-pickup@rmv2`, startMs: start, endMs: start + 30 * 60000,
      summary: `📷 Pickup — ${r.renter_name} (${label})`,
      description: `Rental pickup for ${r.renter_name}. Items: ${label}. Thread ${r.thread_id}.`,
      location: r.pickup_address ?? undefined, alarmMin: leadMin,
    });
  }
  if (r.return_date && r.return_time) {
    const start = londonToUtcMs(r.return_date, r.return_time);
    out.push({
      uid: `rmv2-${r.thread_id}-return@rmv2`, startMs: start, endMs: start + 30 * 60000,
      summary: `↩️ Return — ${r.renter_name} (${label})`,
      description: `Rental return from ${r.renter_name}. Items: ${label}. Thread ${r.thread_id}.`,
      location: r.pickup_address ?? undefined, alarmMin: returnLeadMin,
    });
  }
  return out;
}

// ── CalDAV client (Basic auth; hand-rolled PROPFIND/PUT/DELETE) ───────────────
function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}
function absUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const u = new URL(base);
  return `${u.protocol}//${u.host}${href.startsWith("/") ? "" : "/"}${href}`;
}
async function propfind(url: string, auth: string, body: string, depth = "0"): Promise<string> {
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: auth, Depth: depth, "Content-Type": "application/xml; charset=utf-8" },
    body,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`PROPFIND ${url} → ${res.status} ${text.slice(0, 200)}`);
  return text;
}
function hrefInside(xml: string, elem: string): string | null {
  const re = new RegExp(`<[^>]*${elem}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<`, "i");
  return re.exec(xml)?.[1]?.trim() ?? null;
}
async function discover(appleId: string, appPassword: string) {
  const auth = basicAuth(appleId, appPassword);
  const p1 = await propfind(ICLOUD_ROOT + "/", auth, `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
  const principalPath = hrefInside(p1, "current-user-principal");
  if (!principalPath) throw new Error("Could not find current-user-principal (check Apple ID + app-specific password)");
  const principalUrl = absUrl(ICLOUD_ROOT, principalPath);
  const p2 = await propfind(principalUrl, auth, `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
  const homeHref = hrefInside(p2, "calendar-home-set");
  if (!homeHref) throw new Error("Could not find calendar-home-set");
  const home = absUrl(principalUrl, homeHref);
  const p3 = await propfind(home, auth, `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`, "1");
  const calendars: Array<{ href: string; name: string }> = [];
  for (const block of p3.split(/<[^>]*response[^>]*>/i).slice(1)) {
    if (!/calendar/i.test(block)) continue;
    const href = /<[^>]*href[^>]*>([^<]+)</i.exec(block)?.[1]?.trim();
    if (!href) continue;
    const name = /<[^>]*displayname[^>]*>([^<]*)</i.exec(block)?.[1]?.trim() || href;
    const supportsEvent = /VEVENT/i.test(block) || !/supported-calendar-component-set/i.test(block);
    if (!supportsEvent) continue;
    calendars.push({ href: absUrl(home, href), name });
  }
  return { principalUrl, home, calendars };
}
async function putEvent(url: string, auth: string, ics: string): Promise<string | null> {
  const res = await fetch(url, { method: "PUT", headers: { Authorization: auth, "Content-Type": "text/calendar; charset=utf-8" }, body: ics });
  if (res.status >= 400) throw new Error(`PUT ${url} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.headers.get("etag");
}
async function deleteEvent(url: string, auth: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: auth } });
  if (res.status >= 400 && res.status !== 404) throw new Error(`DELETE ${url} → ${res.status}`);
}

// ── Actions ──────────────────────────────────────────────────────────────────
export const connectApple = action({
  args: { apple_id: v.string(), app_password: v.string(), calendar_name: v.optional(v.string()) },
  handler: async (ctx, { apple_id, app_password, calendar_name }): Promise<{ ok: boolean; calendars?: string[]; chosen?: string; error?: string }> => {
    try {
      const { principalUrl, home, calendars } = await discover(apple_id, app_password);
      if (!calendars.length) throw new Error("No writable calendars found on this iCloud account");
      const pick =
        (calendar_name && calendars.find((c) => c.name.toLowerCase() === calendar_name.toLowerCase())) ||
        calendars.find((c) => /rental|rmv2|rent/i.test(c.name)) || calendars[0];
      await ctx.runMutation(internal.calendar_apple_db._saveConnection, {
        // The supplied password is used only for this connection check. Syncs
        // always load their credential from the shared vault, never this table.
        patch: { apple_id, app_password: undefined, principal_url: principalUrl, calendar_home: home, calendar_url: pick.href, calendar_name: pick.name, status: "connected", auto_sync: true, last_error: undefined, connected_at: Date.now() },
      });
      const routes = Object.entries(ACCOUNT_CALENDAR_NAMES)
        .map(([account_slug, calendar_name]) => {
          const calendar = calendars.find((entry) => entry.name.toLowerCase() === calendar_name.toLowerCase());
          return calendar ? { account_slug, calendar_name: calendar.name, calendar_url: calendar.href } : null;
        })
        .filter((route): route is { account_slug: string; calendar_name: string; calendar_url: string } => route !== null);
      await ctx.runMutation(internal.calendar_apple_db._saveAccountRoutes, { routes });
      return { ok: true, calendars: calendars.map((c) => c.name), chosen: pick.name };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.calendar_apple_db._saveConnection, { patch: { apple_id, status: "error", last_error: msg } });
      return { ok: false, error: msg };
    }
  },
});

/** Connect using the server-side Apple credentials stored in the shared vault. */
export const connectFromVault = action({
  args: { calendar_name: v.optional(v.string()) },
  handler: async (ctx, { calendar_name }): Promise<{ ok: boolean; calendars?: string[]; chosen?: string; error?: string }> => {
    try {
      const { appleId, appPassword } = await getVaultAppleCredentials();
      const { principalUrl, home, calendars } = await discover(appleId, appPassword);
      if (!calendars.length) throw new Error("No writable calendars found on this iCloud account");
      const pick =
        (calendar_name && calendars.find((c) => c.name.toLowerCase() === calendar_name.toLowerCase())) ||
        calendars.find((c) => /rental|rmv2|rent/i.test(c.name)) || calendars[0];
      await ctx.runMutation(internal.calendar_apple_db._saveConnection, {
        patch: { apple_id: appleId, app_password: undefined, principal_url: principalUrl, calendar_home: home, calendar_url: pick.href, calendar_name: pick.name, status: "connected", auto_sync: true, last_error: undefined, connected_at: Date.now() },
      });
      return { ok: true, calendars: calendars.map((c) => c.name), chosen: pick.name };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.calendar_apple_db._saveConnection, { patch: { status: "error", last_error: msg } });
      return { ok: false, error: msg };
    }
  },
});

export const testConnection = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; error?: string }> => {
    const c = await ctx.runQuery(internal.calendar_apple_db._getConnection, {});
    if (!c?.apple_id) return { ok: false, error: "not connected" };
    try {
      const { appleId, appPassword } = await getVaultAppleCredentials();
      await discover(appleId, appPassword);
      return { ok: true };
    }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  },
});

export const disconnect = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean }> => {
    await ctx.runMutation(internal.calendar_apple_db._saveConnection, { patch: { status: "disconnected", app_password: undefined, calendar_url: undefined, auto_sync: false } });
    return { ok: true };
  },
});

/** Push (create/update) the pickup + return events for ONE reservation. */
export const syncReservation = action({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<{ ok: boolean; synced?: number; removed?: number; error?: string }> => {
    const c = await ctx.runQuery(internal.calendar_apple_db._getConnection, {});
    if (c?.status !== "connected" || !c.apple_id || !c.calendar_url) return { ok: false, error: "not connected" };
    let credentials: { appleId: string; appPassword: string };
    try { credentials = await getVaultAppleCredentials(); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const auth = basicAuth(credentials.appleId, credentials.appPassword);
    const r = (await ctx.runQuery(internal.calendar_apple_db._getReservationForCal, { thread_id })) as ResForCal | null;
    const route = r?.account_slug
      ? await ctx.runQuery(internal.calendar_apple_db._getAccountRoute, { account_slug: r.account_slug })
      : null;
    const calendarUrl = route?.calendar_url ?? c.calendar_url;
    const base = calendarUrl.endsWith("/") ? calendarUrl : calendarUrl + "/";
    const lead = c.reminder_lead_min ?? 60;
    const retLead = c.return_reminder_lead_min ?? lead;
    const links = await ctx.runQuery(internal.calendar_apple_db._getEventLinks, { thread_id });
    const linkByUid = new Map(links.map((l) => [l.event_uid, l]));

    const finished = !r || ["cancelled", "declined", "completed"].includes(r.status);
    const events = finished ? [] : eventsForReservation(r as ResForCal, lead, retLead);
    const wantUids = new Set(events.map((e) => e.uid));

    let synced = 0, removed = 0;
    try {
      for (const e of events) {
        const kind = e.uid.includes("-return@") ? "return" : "pickup";
        const ics = buildVCalendar(buildVEvent(e, Date.now()));
        // DTSTAMP changes on every sync by definition. Hash only a stable
        // rendering so an unchanged event does not get PUT again on every cron.
        const hash = sha(buildVCalendar(buildVEvent(e, 0)));
        const prior = linkByUid.get(e.uid);
        if (prior?.ics_hash === hash) continue;
        const href = base + encodeURIComponent(e.uid) + ".ics";
        const etag = await putEvent(href, auth, ics);
        await ctx.runMutation(internal.calendar_apple_db._saveEventLink, { thread_id, kind, event_uid: e.uid, event_href: href, etag: etag ?? undefined, ics_hash: hash });
        synced++;
      }
      for (const l of links) {
        if (wantUids.has(l.event_uid)) continue;
        await deleteEvent(l.event_href, auth);
        await ctx.runMutation(internal.calendar_apple_db._deleteEventLink, { id: l._id });
        removed++;
      }
      // Stamp only when this pass actually wrote something (or a prior error
      // needs clearing). The unconditional patch re-versioned the single
      // calendar_connection row for EVERY confirmed thread on EVERY 30-min
      // autoSyncTick — even fully-idle ones — re-firing every getStatus
      // subscriber. Nothing reads last_sync_at as a must-advance heartbeat
      // (it's only surfaced by getStatus), so an idle pass skips the patch.
      if (synced > 0 || removed > 0 || c.last_error) {
        await ctx.runMutation(internal.calendar_apple_db._saveConnection, { patch: { last_sync_at: Date.now(), last_error: undefined } });
      }
      return { ok: true, synced, removed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.calendar_apple_db._saveConnection, { patch: { last_error: msg } });
      return { ok: false, error: msg, synced, removed };
    }
  },
});

export const unsyncReservation = action({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<{ ok: boolean; removed: number }> => {
    const c = await ctx.runQuery(internal.calendar_apple_db._getConnection, {});
    if (c?.status !== "connected" || !c.apple_id) return { ok: false, removed: 0 };
    let credentials: { appleId: string; appPassword: string };
    try { credentials = await getVaultAppleCredentials(); }
    catch { return { ok: false, removed: 0 }; }
    const auth = basicAuth(credentials.appleId, credentials.appPassword);
    const links = await ctx.runQuery(internal.calendar_apple_db._getEventLinks, { thread_id });
    let removed = 0;
    for (const l of links) {
      await deleteEvent(l.event_href, auth);
      await ctx.runMutation(internal.calendar_apple_db._deleteEventLink, { id: l._id });
      removed++;
    }
    return { ok: true, removed };
  },
});

/** Cron tick: keep the calendar in sync automatically. No-op unless connected
 * AND auto_sync is on. Idempotent — unchanged events are skipped via ics_hash. */
export const autoSyncTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ran: boolean }> => {
    const c = await ctx.runQuery(internal.calendar_apple_db._getConnection, {});
    if (c?.status !== "connected" || !c.auto_sync) return { ran: false };
    await ctx.runAction(api.calendar_apple.syncAllConfirmed, {});
    return { ran: true };
  },
});

/** Bulk: push every currently-confirmed booking. Idempotent (safe to re-run). */
export const syncAllConfirmed = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; threads: number; synced: number; removed: number; error?: string }> => {
    const c = await ctx.runQuery(internal.calendar_apple_db._getConnection, {});
    if (c?.status !== "connected") return { ok: false, threads: 0, synced: 0, removed: 0, error: "not connected" };
    const threads = await ctx.runQuery(internal.calendar_apple_db._listConfirmedThreads, {});
    let synced = 0, removed = 0;
    for (const t of threads) {
      let r: { ok?: boolean; synced?: number; removed?: number } | null = null;
      try { r = await ctx.runAction(api.calendar_apple.syncReservation, { thread_id: t }); } catch { r = null; }
      if (r?.ok) { synced += r.synced ?? 0; removed += r.removed ?? 0; }
    }
    return { ok: true, threads: threads.length, synced, removed };
  },
});
