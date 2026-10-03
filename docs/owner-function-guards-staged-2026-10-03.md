# Shared owner function guards, staged — 3 October 2026

The private login identity now has a shared backend authorization boundary. All 404 operational public query/mutation/action registrations use protected builders; the only raw public query exemption is the minimal login-state query. The builders preserve Convex argument/return validators and handler types. Internal registrations remain Convex internal-only functions. The 121 registration-file edits change imports only; handler bodies remain byte-for-byte unchanged.

When enforcement is enabled, anonymous calls, wrong issuers, unbound users and revoked owner sessions are rejected before the original handler runs. A valid owner must match both the server owner binding and the live Better Auth session. The exact reserved service issuer/subject is intended for deployment-key admin transport, not a role supplied in RPC arguments. Malformed enforcement configuration fails closed.

The source checker runs before typechecking in CI and rejects raw public SDK imports, aliases, namespace imports and additional bootstrap builder uses. Manual injected alias/namespace bypass cases were rejected and removed. Source proof: `/root/rental-owner-boundary-source-proof.json`.

Validation: 1,236 tests passed, 14 skipped across 95 files; Next production build and Convex backend typecheck passed. Tests exercise the actual registered query/mutation/action handlers with enforcement enabled: unauthorized calls never enter their handlers; revoked sessions fail and valid owners preserve arguments/results. Internal builders remain identical to the original SDK builders.

## Enforcement is not active yet

`OWNER_AUTH_REQUIRED` is currently unset. The staged builders preserve existing operation until trusted internal/background callers, owner-authenticated Next routes, frontend access handling and owner setup are connected and verified. This does not close the proved anonymous operational RPC gap yet. The rollout switch must be removed after complete cutover. Do not report 404 secured production functions while enforcement is inactive.

Next caller work is identified in `/root/rental-owner-auth-boundary-callers.json`: 66 direct public references to 45 targets inside Convex need inspection/internal equivalents; dynamic function references need separate coverage. Trigger/server clients need private authenticated transport; public webhook handlers must retain their signature checks and call internal functions. Browser and Next owner requests need their real owner tokens. Real Hygglo activation, automated rental messages and booking writes remain separately gated by explicit written consent.
