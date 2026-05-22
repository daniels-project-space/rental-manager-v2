# Vacation Mode — Telegram Webhook Setup (Wave 4)

Inbound webhook for `/vacation` commands. Routed by `convex/http.ts` →
`convex/telegram_inbound.ts:handleTelegramUpdate`.

## 1. Required Convex env vars

Set these on the **prod Convex deployment** (where the webhook lives):

```bash
cd /home/ubuntu/rental-manager-v2

# Random ~32-char string shared with Telegram. Generate one:
#   openssl rand -hex 24
npx convex env set TELEGRAM_WEBHOOK_SECRET <random-32-char-string>

# Daniel's personal Telegram chat id (numeric, as string).
# Get it from @userinfobot — message it once, it replies with "Id: 123456789".
npx convex env set TELEGRAM_ADMIN_CHAT_ID <numeric-chat-id>
```

Already set (reused outbound — verify with `npx convex env list`):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID_DANIEL` (legacy outbound — same number as `TELEGRAM_ADMIN_CHAT_ID`)

## 2. Register the webhook with Telegram (one-time)

After the env vars are set and the next Convex deploy has shipped, register
the webhook URL with Telegram. **Substitute the real bot token, secret, and
deployment URL** — do NOT commit them.

```bash
# Replace placeholders:
#   <BOT_TOKEN>     — value of TELEGRAM_BOT_TOKEN
#   <SECRET>        — value of TELEGRAM_WEBHOOK_SECRET (URL-encode if it has special chars)
#   <CONVEX_URL>    — your Convex prod URL, e.g. https://courageous-llama-123.convex.site
#                     (use .convex.site, NOT .convex.cloud, for HTTP actions)

curl -F "url=<CONVEX_URL>/telegram/webhook?secret=<SECRET>" \
     -F "allowed_updates=[\"message\"]" \
     "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook"
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`

Verify with:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## 3. Commands

All case-insensitive. Date formats: `2026-07-01`, `7/1` (UK day/month),
`Jul 1`, `1 July`. Year is inferred (rolls to next year if past).

| Command | Effect |
|---------|--------|
| `/vacation` | Show active vacations + help |
| `/vacation status` | Alias for `/vacation` |
| `/vacation set <start> to <end> [reason]` | Create vacation. Examples below. |
| `/vacation cancel <#index>` | Cancel by 1-based index from `/vacation` listing |
| `/vacation cancel <_id>` | Cancel by raw Convex id |
| `/vacation force` | Confirm a prior set that hit `CONFIRMED_CONFLICTS` (within 5 min) |

Natural-language fallback (must parse dates): `vacation Jul 1 to Jul 14`,
`im away 2026-08-01 to 2026-08-10`, `off 7/15 to 7/20 holiday`.

### Examples

```
/vacation set 2026-07-01 to 2026-07-14
/vacation set Jul 1 to Jul 14 surgery recovery
/vacation set 7/1 to 7/14
/vacation cancel #2
```

## 4. Conflict flow

1. `/vacation set …` first calls `vacation.checkVacationConflicts`.
2. If **confirmed bookings** overlap → bot lists them and stashes a row in
   `pending_vacation_confirmations` (TTL 5 min, keyed by chat id).
3. Reply `/vacation force` within 5 min → bot calls
   `vacation.setVacation({force: true, created_by: "telegram"})` and deletes
   the pending row.
4. If only **pending requests** overlap → set proceeds, reply notes the count.
5. No conflicts → set proceeds, confirmation reply.

## 5. Schema

New table in `convex/schema.ts`:

```ts
pending_vacation_confirmations: defineTable({
  chat_id: v.string(),
  start_date: v.string(),
  end_date: v.string(),
  reason: v.optional(v.string()),
  expires_at: v.number(),
})
  .index("by_chat", ["chat_id"])
  .index("by_expires", ["expires_at"]),
```

(No cron to GC expired rows — they're overwritten on next `/vacation set`
from the same chat, and ignored at read time if `expires_at < Date.now()`.
Add a daily cleanup cron later if the table grows.)

## 6. Security

- Webhook auth is by `?secret=` query-param shared secret. Telegram does not
  natively sign requests; the secret is the only auth layer.
- Additional check: `message.chat.id` MUST equal `TELEGRAM_ADMIN_CHAT_ID`.
  Other chats get a silent 200 (no leak that the endpoint exists).
- A wrong/missing secret returns **401**, so an attacker probing the URL
  with random secrets is detectable in Convex logs.

## 7. Smoke tests

```bash
# Should return 401 (no secret)
curl -X POST 'https://<deploy>.convex.site/telegram/webhook' \
  -H 'content-type: application/json' -d '{}'

# Should return 401 (wrong secret)
curl -X POST 'https://<deploy>.convex.site/telegram/webhook?secret=wrong' \
  -H 'content-type: application/json' -d '{}'

# After webhook registration, message the bot on Telegram:
#   /vacation
# → bot replies with active list + help.
```

## 8. Files

- `convex/http.ts` — HTTP router, webhook auth + dispatch
- `convex/telegram_inbound.ts` — command dispatcher, date parser, pending-confirmation table helpers, outbound `sendReply`
- `convex/schema.ts` — added `pending_vacation_confirmations` table
- `convex/vacation.ts` — unchanged (already exists; used as-is)
- `convex/lib/telegram_convex.ts` — unchanged (outbound helper, hard-coded to admin chat — still used by other features)
