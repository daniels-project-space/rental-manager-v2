/**
 * Wave 4 — Inbound Telegram webhook handler for vacation mode.
 *
 * Routed from convex/http.ts at `POST /telegram/webhook?secret=...`.
 *
 * Commands (case-insensitive):
 *   /vacation                    — show active vacations + help
 *   /vacation status             — alias for /vacation
 *   /vacation set <s> to <e> [reason]
 *   /vacation cancel <id|index>
 *   /vacation force              — confirm pending CONFIRMED_CONFLICTS set
 *
 * Natural language fallback: messages starting with "vacation" / "im away" /
 * "off " with parseable dates also attempt the set flow.
 *
 * REQUIRED Convex env vars (set via `npx convex env set ...`):
 *   - TELEGRAM_WEBHOOK_SECRET   — random ~32-char string, query-param shared secret
 *   - TELEGRAM_ADMIN_CHAT_ID    — Daniel's Telegram chat id (numeric, as string)
 *   - TELEGRAM_BOT_TOKEN        — already used by lib/telegram_convex.ts (outbound)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ────────────────────────────────────────────────────────────────────────────
// Outbound helper — chat-specific (lib/telegram_convex.ts is hard-coded to
// TELEGRAM_CHAT_ID_DANIEL; webhook handler must reply to whichever chat sent
// the message, even though we currently only accept ADMIN_CHAT_ID).
// ────────────────────────────────────────────────────────────────────────────

async function sendReply(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // best-effort; webhook still returns 200 to Telegram
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Date parsing — ISO, slash (UK day/month/year), month-name. Year defaults to
// current Europe/London year, rolling to next year if the date is already past.
// ────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function todayLondonYMD(): string {
  // Europe/London ISO YMD via Intl
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

function isValidYMD(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // round-trip date check
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse one date token (or multi-token slice). Returns YYYY-MM-DD or null.
 * Accepts:
 *   - 2026-07-01           ISO
 *   - 7/1/2026, 01/07/2026 UK-format (day/month/year) — when first part > 12 force day-first
 *   - 1/7, 01/07           UK day/month (year inferred)
 *   - Jul 1, July 1        month-name day
 *   - 1 Jul, 1 July        day month-name
 */
function parseDate(raw: string, todayYMD: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // ISO
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const ymd = `${y}-${pad2(m)}-${pad2(d)}`;
    return isValidYMD(ymd) ? ymd : null;
  }

  // Slash format — assume UK day/month/[year]
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    let day = Number(slash[1]);
    let month = Number(slash[2]);
    // If first > 12 it's unambiguous day-first; if month > 12 swap (US-format leak)
    if (month > 12 && day <= 12) {
      const tmp = day; day = month; month = tmp;
    }
    let year: number;
    if (slash[3]) {
      year = Number(slash[3]);
      if (year < 100) year += 2000;
    } else {
      year = Number(todayYMD.slice(0, 4));
    }
    const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
    if (!isValidYMD(ymd)) return null;
    // roll forward if already past and no explicit year
    if (!slash[3] && ymd < todayYMD) {
      return `${year + 1}-${pad2(month)}-${pad2(day)}`;
    }
    return ymd;
  }

  // Month-name day OR day month-name (optional year)
  const nameDay = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{2,4}))?$/);
  const dayName = s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:[,\s]+(\d{2,4}))?$/);
  let monStr: string | null = null;
  let dayStr: string | null = null;
  let yearStr: string | null = null;
  if (nameDay) {
    monStr = nameDay[1];
    dayStr = nameDay[2];
    yearStr = nameDay[3] ?? null;
  } else if (dayName) {
    dayStr = dayName[1];
    monStr = dayName[2];
    yearStr = dayName[3] ?? null;
  }
  if (monStr && dayStr) {
    const month = MONTHS[monStr];
    if (!month) return null;
    const day = Number(dayStr);
    let year: number;
    if (yearStr) {
      year = Number(yearStr);
      if (year < 100) year += 2000;
    } else {
      year = Number(todayYMD.slice(0, 4));
    }
    const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
    if (!isValidYMD(ymd)) return null;
    if (!yearStr && ymd < todayYMD) {
      return `${year + 1}-${pad2(month)}-${pad2(day)}`;
    }
    return ymd;
  }

  return null;
}

/**
 * Split "<start> to <end> [reason]" — returns {start, end, reason} or null.
 * Greedy: tries successively longer "start" slices to find a parseable split.
 */
function parseSetArgs(text: string): { start: string; end: string; reason?: string } | null {
  const today = todayLondonYMD();
  // Find "to" / "until" / "-" separator (word-boundary for to/until)
  const sep = text.match(/\s+(?:to|until|->|–|—)\s+/i) ?? text.match(/\s+-\s+/);
  if (!sep || sep.index === undefined) return null;
  const startRaw = text.substring(0, sep.index).trim();
  const after = text.substring(sep.index + sep[0].length).trim();
  if (!after) return null;

  const start = parseDate(startRaw, today);
  if (!start) return null;

  // Try longest-end-first: walk back word-by-word to find a parseable end date.
  const tokens = after.split(/\s+/);
  for (let take = Math.min(4, tokens.length); take >= 1; take--) {
    const endCandidate = tokens.slice(0, take).join(" ");
    const end = parseDate(endCandidate, today);
    if (end) {
      const reason = tokens.slice(take).join(" ").trim() || undefined;
      return { start, end, reason };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Pending-confirmation table helpers (internal mutations / query)
// ────────────────────────────────────────────────────────────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000;

export const upsertPendingConfirmation = internalMutation({
  args: {
    chat_id: v.string(),
    start_date: v.string(),
    end_date: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Delete existing rows for this chat (keep one pending at a time)
    const existing = await ctx.db
      .query("pending_vacation_confirmations")
      .withIndex("by_chat", (q) => q.eq("chat_id", args.chat_id))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert("pending_vacation_confirmations", {
      chat_id: args.chat_id,
      start_date: args.start_date,
      end_date: args.end_date,
      reason: args.reason,
      expires_at: Date.now() + PENDING_TTL_MS,
    });
    return null;
  },
});

export const getPendingForChat = internalQuery({
  args: { chat_id: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("pending_vacation_confirmations"),
      start_date: v.string(),
      end_date: v.string(),
      reason: v.optional(v.string()),
      expires_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pending_vacation_confirmations")
      .withIndex("by_chat", (q) => q.eq("chat_id", args.chat_id))
      .collect();
    if (rows.length === 0) return null;
    // Pick the freshest (highest expires_at)
    rows.sort((a, b) => b.expires_at - a.expires_at);
    const r = rows[0];
    return {
      _id: r._id,
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
      expires_at: r.expires_at,
    };
  },
});

export const deletePending = internalMutation({
  args: { id: v.id("pending_vacation_confirmations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return null;
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Main dispatcher — called from http.ts httpAction.
// Returns the reply text (for logging/tests); also sends it via Telegram.
// ────────────────────────────────────────────────────────────────────────────

export const handleTelegramUpdate = internalAction({
  args: {
    chat_id: v.string(),
    text: v.string(),
    username: v.optional(v.string()),
  },
  returns: v.object({ ok: v.boolean(), reply: v.string() }),
  handler: async (ctx, args): Promise<{ ok: boolean; reply: string }> => {
    const reply = await dispatch(ctx, args.chat_id, args.text, args.username);
    if (reply) await sendReply(args.chat_id, reply);
    return { ok: true, reply };
  },
});

async function dispatch(
  ctx: any,
  chatId: string,
  rawText: string,
  _username: string | undefined,
): Promise<string> {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // /vacation force — confirm prior pending
  if (/^\/vacation\s+force\b/i.test(text) || /^force\b/i.test(text)) {
    return await handleForce(ctx, chatId);
  }

  // /vacation cancel ...
  const cancelMatch = text.match(/^\/vacation\s+cancel\s+(.+)$/i);
  if (cancelMatch) {
    return await handleCancel(ctx, cancelMatch[1].trim());
  }

  // /vacation set ...
  const setMatch = text.match(/^\/vacation\s+set\s+(.+)$/i);
  if (setMatch) {
    return await handleSet(ctx, chatId, setMatch[1].trim());
  }

  // /vacation, /vacation status, /vacation help
  if (/^\/vacation(\s+(status|help|list))?\s*$/i.test(text)) {
    return await handleStatus(ctx);
  }

  // Natural-language fallback
  if (
    lower.startsWith("vacation ") ||
    lower.startsWith("im away") ||
    lower.startsWith("i'm away") ||
    lower.startsWith("off ")
  ) {
    // strip leading verb
    const body = text
      .replace(/^(vacation|im away|i'm away|off)\s+/i, "")
      .trim();
    const parsed = parseSetArgs(body);
    if (parsed) {
      return await handleSet(ctx, chatId, body);
    }
  }

  // Unknown — only reply if it looked like a /command
  if (text.startsWith("/")) {
    return helpText();
  }
  return ""; // silent for non-command chatter
}

function helpText(): string {
  return [
    "*Vacation commands*",
    "`/vacation` — show active vacations",
    "`/vacation set <start> to <end> [reason]`",
    "`/vacation cancel <id|#index>`",
    "`/vacation force` — confirm previous conflict-set within 5 min",
    "",
    "Date formats: `2026-07-01`, `7/1` (UK), `Jul 1`, `1 July`",
  ].join("\n");
}

async function handleStatus(ctx: any): Promise<string> {
  const active: Array<{
    _id: Id<"vacation_periods">;
    start_date: string;
    end_date: string;
    reason?: string;
    created_by?: string;
  }> = await ctx.runQuery(api.vacation.getActiveVacations, {});
  if (active.length === 0) {
    return [
      "No active vacations.",
      "",
      helpText(),
    ].join("\n");
  }
  const lines = active.map(
    (v, i) =>
      `${i + 1}. *${v.start_date} → ${v.end_date}*${v.reason ? ` — ${escapeMd(v.reason)}` : ""} \\(id: \`${v._id}\`\\)`,
  );
  return ["*Active vacations:*", ...lines, "", helpText()].join("\n");
}

async function handleSet(ctx: any, chatId: string, body: string): Promise<string> {
  const parsed = parseSetArgs(body);
  if (!parsed) {
    return "Couldn't read those dates. Use YYYY-MM-DD format, e.g. `/vacation set 2026-07-01 to 2026-07-14`";
  }
  const { start, end, reason } = parsed;

  // Pre-check conflicts so we can stash pending state BEFORE invoking setVacation
  let conflicts: {
    confirmed: Array<{
      renter_name?: string;
      start_date: string;
      end_date: string;
      total_gbp: number;
    }>;
    pending: Array<{ start_date: string; end_date: string }>;
  };
  try {
    conflicts = await ctx.runQuery(api.vacation.checkVacationConflicts, {
      start_date: start,
      end_date: end,
    });
  } catch (e: any) {
    return `Conflict-check failed: ${e?.message ?? "unknown error"}`;
  }

  if (conflicts.confirmed.length > 0) {
    // Stash pending and ask for /vacation force
    await ctx.runMutation(internal.telegram_inbound.upsertPendingConfirmation, {
      chat_id: chatId,
      start_date: start,
      end_date: end,
      reason,
    });
    const lines = conflicts.confirmed.map(
      (c) =>
        `• ${c.renter_name ?? "(unknown)"} ${c.start_date}→${c.end_date} £${c.total_gbp.toFixed(2)}`,
    );
    return [
      `*Conflicts on ${start} → ${end}:*`,
      ...lines,
      "",
      conflicts.pending.length > 0
        ? `Plus ${conflicts.pending.length} pending request(s) overlap.`
        : "",
      "Reply `/vacation force` within 5 min to set anyway \\(keeping these bookings\\).",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // No confirmed conflicts — commit
  try {
    const result = await ctx.runMutation(api.vacation.setVacation, {
      start_date: start,
      end_date: end,
      reason,
      created_by: "telegram",
    });
    const pendN = result.pending_conflicts?.length ?? 0;
    return [
      `Vacation set: *${start} → ${end}*${reason ? ` — ${escapeMd(reason)}` : ""}`,
      pendN > 0
        ? `${pendN} pending request\\(s\\) overlap — handle in renter bot drafts.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e: any) {
    return `setVacation failed: ${e?.message ?? "unknown"}`;
  }
}

async function handleForce(ctx: any, chatId: string): Promise<string> {
  const pending = await ctx.runQuery(internal.telegram_inbound.getPendingForChat, {
    chat_id: chatId,
  });
  if (!pending) {
    return "No pending vacation to confirm. Send `/vacation set …` first.";
  }
  if (pending.expires_at < Date.now()) {
    await ctx.runMutation(internal.telegram_inbound.deletePending, { id: pending._id });
    return "Pending confirmation expired \\(>5 min\\). Resend `/vacation set …`.";
  }
  try {
    const result = await ctx.runMutation(api.vacation.setVacation, {
      start_date: pending.start_date,
      end_date: pending.end_date,
      reason: pending.reason,
      force: true,
      created_by: "telegram",
    });
    await ctx.runMutation(internal.telegram_inbound.deletePending, { id: pending._id });
    const pendN = result.pending_conflicts?.length ?? 0;
    return [
      `Vacation force-set: *${pending.start_date} → ${pending.end_date}* — conflicting bookings kept.`,
      pendN > 0 ? `${pendN} pending request\\(s\\) overlap.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e: any) {
    return `setVacation force failed: ${e?.message ?? "unknown"}`;
  }
}

async function handleCancel(ctx: any, arg: string): Promise<string> {
  const active: Array<{
    _id: Id<"vacation_periods">;
    start_date: string;
    end_date: string;
  }> = await ctx.runQuery(api.vacation.getActiveVacations, {});
  if (active.length === 0) {
    return "No active vacations to cancel.";
  }
  // Index form: "1", "#2"
  const idxMatch = arg.match(/^#?(\d+)$/);
  let target: Id<"vacation_periods"> | null = null;
  if (idxMatch) {
    const i = Number(idxMatch[1]) - 1;
    if (i < 0 || i >= active.length) {
      return `Index out of range. Active vacations: 1..${active.length}`;
    }
    target = active[i]._id;
  } else {
    // Treat as raw _id — verify it appears in active list
    const hit = active.find((v) => String(v._id) === arg);
    if (!hit) {
      return `Unknown vacation id. Use \`/vacation\` to list.`;
    }
    target = hit._id;
  }
  try {
    await ctx.runMutation(api.vacation.cancelVacation, { vacation_id: target });
    return `Vacation cancelled: \`${target}\``;
  } catch (e: any) {
    return `cancelVacation failed: ${e?.message ?? "unknown"}`;
  }
}

function escapeMd(s: string): string {
  // minimal MarkdownV1 escaping for *, _, `, [
  return s.replace(/([*_`\[])/g, "\\$1");
}
