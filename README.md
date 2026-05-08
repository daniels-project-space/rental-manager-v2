# Rental Manager v2

Cloud-native rebuild of the rental-manager bot. Two Hygglo accounts (`leo` + `dbcinema`) sharing one inventory and one calendar, with every outbound reply gated through Daniel's Telegram review.

> **READ-ONLY safety rail — #1 invariant.** The bot MUST NEVER send a message to a renter on Hygglo. Every draft lands in Telegram for human review. Three independent guards (`ALLOW_HYGGLO_SEND` env, Convex `settings` row, runtime check inside the Stagehand `sendMessage` tool) all default to refusal. Lifting the rail is a Phase 7 cutover with a signed acceptance document.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 16 + React 19 + Tailwind 4 (Vercel) |
| Database | Convex (own deployment, reactive subscribe) |
| Background jobs | Trigger.dev v3 (project `rental-manager-v2-jobs`) |
| Agents | Mastra (embedded in Trigger tasks, no separate runtime) |
| Browser automation | Stagehand on Browserbase, two persistent contexts |
| LLMs | Grok 4.1 Fast default + Sonnet 4.6 escalation, via Vercel AI SDK |
| Storage | Cloudflare R2 (`rental-manager-v2` bucket: photos + attachments + DB snapshots) |
| Auth | Vercel Password Protection |
| Operator channel | Telegram (Daniel only) |

Secrets live in the project-hub Convex vault at `https://fantastic-roadrunner-485.convex.cloud`. Apps fetch them at runtime via `secrets:listByService`. Nothing is hardcoded.

## Local dev (run from VPS or desktop)

```bash
npm install
npx convex dev          # provisions Convex deployment, writes .env.local
npm run dev             # http://localhost:3000
```

## Deploy

Vercel auto-deploys on push to `main`.

## Migration plan

The full phased plan lives at `/home/ubuntu/rental-manager-v2-plan/migration-plan.md` on the VPS. Summary:

- **Phase 0** — cloud infra wiring (this scaffold).
- **Phase 1** — inventory + account profiles.
- **Phase 2** — historical data import + money parity gate.
- **Phase 3** — Stagehand + Hygglo READ-ONLY polling.
- **Phase 4** — Mastra Planner + tools + Sonnet escalation.
- **Phase 5** — full-parity dashboard.
- **Phase 6** — Telegram QA loop.
- **Phase 7** — approve-to-send cutover (requires signed acceptance).

## Repository

- GitHub: `daniels-project-space/rental-manager-v2`
- Local path: `/home/ubuntu/rental-manager-v2`
- Vercel: `rental-manager-v2`
- Convex: see `.env.local` after first `npx convex dev`
- R2 bucket: `rental-manager-v2`
- Trigger.dev project: `rental-manager-v2-jobs`

Old VPS bot at `/home/ubuntu/rental-manager` is frozen and read-only during migration. Old WIP `/home/ubuntu/rental-bot-v2` is slated for deletion (Phase 0 step 2 of the plan).
