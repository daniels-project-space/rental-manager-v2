# Bot style flags and access audit — 3 October 2026

The actual accepted Great Joy fallback reply had a `critical INTERNAL_ACTION` flag solely for rewriting “we/our” into “I/my”. The production guard had corrected the reply, but the Lab rubric marked that critical correction for review. This conflated owner voice with leaked backstage instructions.

The voice rewrite now emits `FIRST_PERSON_STYLE`, severity `low`, action `rewritten`. Real internal notes and cross-account owner-name leakage retain `critical INTERNAL_ACTION`. A regression exercises the real guard through the rubric and verifies both the harmless correction and genuine internal-note path. Replaying the captured actual model candidate produces exactly the same final renter text with the corrected style label.

Validation: 1,225 tests passed, 14 skipped across 92 files; Next production build and Convex backend typecheck passed. Graphify updated. Local actual candidate evidence: `/root/rental-style-guard-replay-proof.json`.

## Unfinished owner access boundary

A live request without authorization successfully called `settings:get` and `settings:update` with empty arguments. The latter changed no fields: before/after settings were equal and draft epoch stayed 73. Separately, the source explicitly rejects `ALLOW_HYGGLO_SEND:true`, so this observation does not prove that anonymous callers can enable automated renter messages.

An AST inventory found 404 exported public query/mutation/action registrations and 328 internal registrations. None of those public registration bodies directly referenced the scanned authentication helpers. This is a source inventory, not proof that all 404 functions lack authorization through callees. It identifies the scope to inspect. The current browser provider and multiple Next server routes use Convex clients without an owner login identity. Backend RPCs, owner UI, server routes, background jobs and push notification access must be secured together; adding only a login screen would leave direct RPCs accessible.

Evidence: `/root/rental-settings-access-readonly-audit-proof.json` and `/root/rental-auth-function-inventory.json`. No authentication migration has been deployed. Login preference question is pending. Real Hygglo activation, messaging and booking writes remain separately gated by explicit written consent.
