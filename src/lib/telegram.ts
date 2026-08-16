/**
 * Minimal Telegram Bot API client for Daniel's review channel.
 *
 * Decision A-1 + A-4: Telegram is the PRIMARY review channel — every draft
 * is posted as a compact card with Reply/Edit/Dismiss buttons. No dashboard
 * widget in Phase 1.
 *
 * Secrets: Bot token + default chat_id live in the project-hub Convex vault
 * under service "telegram":
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_OPERATOR_CHAT_ID    (Daniel's personal chat id)
 *
 * Used by:
 *   - src/trigger/renter-bot-batch.ts (after workflow run, posts new drafts)
 *
 * READ-ONLY: this module only sends OUTBOUND Telegram messages to Daniel.
 * It never sends anything to renters. The Hygglo side stays untouched.
 */
import "server-only";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

interface VaultSecret {
  keyName: string;
  value: string;
}

let _cache: { token: string; chatId: string } | null = null;

async function getCredentials(): Promise<{ token: string; chatId: string }> {
  if (_cache) return _cache;
  if (
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_OPERATOR_CHAT_ID
  ) {
    _cache = {
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_OPERATOR_CHAT_ID,
    };
    return _cache;
  }
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service: "telegram", vaultToken },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  const data = (await res.json()) as { value: VaultSecret[] };
  const map: Record<string, string> = {};
  for (const s of data.value ?? []) map[s.keyName] = s.value;
  const token = map.TELEGRAM_BOT_TOKEN;
  const chatId = map.TELEGRAM_OPERATOR_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "Telegram credentials missing in vault (expected TELEGRAM_BOT_TOKEN + TELEGRAM_OPERATOR_CHAT_ID under service 'telegram')",
    );
  }
  _cache = { token, chatId };
  return _cache;
}

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  message_id?: string;
  chat_id?: string;
  error?: string;
}

/**
 * System-generated Telegram must be explicitly enabled, never default-on.
 * Mirrors `convex/lib/telegram_convex.ts` so both runtimes share one switch.
 */
export function automatedTelegramAlertsEnabled(
  configuredValue = process.env.AUTOMATED_TELEGRAM_ALERTS,
): boolean {
  return configuredValue === "1";
}

/**
 * Send a plain-text Telegram message to Daniel's operator chat. Uses HTML
 * parse mode for light formatting (bold renter name, italic intent label).
 *
 * Fail-closed: returns `{ ok: false, skipped: true }` unless
 * AUTOMATED_TELEGRAM_ALERTS=1. Callers should treat `skipped` as a no-op,
 * not a delivery failure.
 */
export async function sendOperatorMessage(text: string): Promise<TelegramSendResult> {
  if (!automatedTelegramAlertsEnabled()) {
    return { ok: false, skipped: true, error: "automated_alerts_disabled" };
  }
  try {
    const { token, chatId } = await getCredentials();
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    if (!data?.ok) return { ok: false, error: data?.description ?? "telegram_error" };
    return {
      ok: true,
      message_id: String(data.result?.message_id ?? ""),
      chat_id: String(data.result?.chat?.id ?? chatId),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Draft card formatter ───────────────────────────────────────

export interface DraftCardInput {
  renterName: string | null;
  accountSlug: string;
  inboundBody: string;
  draftText: string;
  intent: string;
  stage?: string;
  redFlags: string[];
  needsHuman: boolean;
  needsHumanReason?: string;
  factsClaimed?: Array<{ kind: string; value: string; sourceTool: string }>;
  threadId: string;
  draftId: string;
}

/**
 * Format a draft card for Telegram. Compact, HTML-formatted.
 *
 * On Daniel's side: he reads the card, copies the draft text, edits if
 * needed, sends manually via Hygglo, then either taps a callback button
 * or runs `npx convex run renter_bot_drafts:markSent` with the final
 * text. Phase 1 doesn't implement the callback receiver yet — Phase 1.5
 * adds inline buttons.
 */
export function formatDraftCard(input: DraftCardInput): string {
  const lines: string[] = [];
  const escape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const header = input.needsHuman
    ? `🔴 <b>HUMAN NEEDED</b> — ${escape(input.intent)}`
    : `📩 <b>${escape(input.renterName ?? "Renter")}</b> · <i>${escape(input.intent)}</i>${
        input.stage ? ` · ${escape(input.stage)}` : ""
      }`;
  lines.push(header);
  lines.push(`account: <code>${escape(input.accountSlug)}</code> · thread: <code>${escape(input.threadId)}</code>`);
  lines.push("");
  lines.push(`<b>Inbound:</b> ${escape(input.inboundBody.slice(0, 500))}${input.inboundBody.length > 500 ? "…" : ""}`);
  lines.push("");
  if (input.needsHuman) {
    lines.push(`<i>${escape(input.needsHumanReason ?? "Escalated — no draft.")}</i>`);
  } else {
    lines.push(`<b>Draft:</b>`);
    lines.push(escape(input.draftText));
  }
  if (input.redFlags.length > 0) {
    lines.push("");
    lines.push(`🚩 ${input.redFlags.map(escape).join(" · ")}`);
  }
  if (input.factsClaimed && input.factsClaimed.length > 0) {
    lines.push("");
    lines.push(
      `<i>facts: ${input.factsClaimed
        .map((f) => `${escape(f.kind)}=${escape(f.value)} [${escape(f.sourceTool)}]`)
        .join(", ")}</i>`,
    );
  }
  lines.push("");
  lines.push(`<i>draft_id: <code>${escape(input.draftId)}</code></i>`);
  return lines.join("\n");
}
