/**
 * Wave 4 — Convex-runtime Telegram sender.
 *
 * The existing `src/lib/telegram.ts` is `import "server-only"` (Next.js
 * server module), so it cannot be imported from Convex actions (Convex
 * runs in V8 isolates, not Node). This module is a minimal, no-deps
 * fetch-based Telegram sender callable from Convex `internalAction`s.
 *
 * Used by:
 *   - convex/poller_health.ts:runStalenessCheck — staleness alerts +
 *     auto-heal notification.
 *
 * REQUIRED Convex prod env vars (set via `npx convex env set ...`):
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_CHAT_ID_DANIEL
 *
 * Returns {ok:false} (without throwing) if either env var is missing —
 * caller decides whether to log/alert via other channel.
 */

export interface TelegramResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
}

export async function sendTelegram(text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID_DANIEL;
  if (!token || !chatId) {
    return { ok: false, skipped: true, reason: "missing_env" };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
