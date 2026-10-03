# Owner authentication foundation — 3 October 2026

The access audit proved that anonymous requests could execute the settings query and an empty settings mutation. The application had no owner identity on either its browser client or several Next server clients. Before enforcing owner authorization across those paths, this change supplies a real login identity and private bootstrap flow.

A Convex-hosted Better Auth component supports email/password login and a seven-day renewable session. Signup requires an exact private invitation whose SHA-256 hash is configured only on the backend. The server fails closed if the invitation is not configured. A transactional singleton owner binding prevents a second signup from becoming another owner; existing owner setup cannot be reused. Rental account IDs and renter verification are not app-owner authentication. Owner email changes are disabled.

The new `/login` page uses a setup invitation from the URL fragment, removes it from browser history, and keeps it only in memory. Authentication requests use the Next same-origin proxy, and the existing app Convex client now receives real authenticated tokens through the supported provider. These routes are connected to the actual component, not a mock login.

## Validation and limits

All 1,226 tests passed with 14 skipped across 93 files after updating Vitest to 3.2.7 to satisfy the auth package peer requirement. The lockfile and installation use the repository's pnpm package manager. Next build and Convex backend typecheck passed. Mobile and desktop login screenshots were inspected.

Native backend checks: signup without an invitation returns 403; anonymous auth state says not authenticated/not owner. A temporary private invitation created an explicitly named owned test account and the resulting Convex JWT resolved as the owner. Reusing the invitation returned 403. Sign-out invalidated the session in backend auth state; a new login restored owner access. The temporary invitation was removed, its owner record restored to the prior state, and fixture auth records cleaned. No rental booking, real renter message or live Hygglo activation was performed.

Evidence: `/root/rental-owner-auth-denied-signup-proof.json`, `/root/rental-owner-auth-native-probe-proof.json`, `/root/rental-owner-login-mobile.png`, `/root/rental-owner-login-desktop.png`.

This foundation does **not** close the existing operational RPC access gap. Owner guards, server-route authorization, trusted background identities, and webhook/internal caller updates must be connected and verified before enforcement is activated. No actual owner setup invitation is enabled in production yet. Recovery and user logout UI also require completion before calling owner authentication production ready. Real Hygglo bot rollout remains gated by separate explicit written consent.

The integration follows the official [Convex Next.js authentication guide](https://labs.convex.dev/better-auth/framework-guides/next) and [Better Auth hooks API](https://better-auth.com/docs/concepts/hooks). Versions are pinned to `@convex-dev/better-auth` 0.12.5 and Better Auth 1.6.15.
