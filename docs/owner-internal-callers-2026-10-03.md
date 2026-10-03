# Internal caller migration — 3 October 2026

Owner authorization cannot safely be activated while background functions still call owner-only public registrations. The shared builders now retain the original definitions and provide typed internal counterparts. Each counterpart registers the same original handler, argument validators and return validators using the native internal-only builder. Calling the guarded public `_handler` would not solve this: it would still reject a background context without an owner session.

All 66 direct public references inside Convex now use 45 internal counterparts. The six string-based references across cron, notification recovery, profile-rate refresh and website booking synchronization now use typed internal references. One old reference labelled the stats-drawer refresh as a mutation although its native registration is an action. Its scheduler accepted either kind, so that mismatch was not established as a runtime failure; the new typed reference accurately describes the existing target. Removed 32 unused public API imports.

The CI source check also rejects Convex server imports of the public API namespace, generated API namespace imports and unchecked `makeFunctionReference` strings. Injected unsafe caller cases were rejected and removed. Existing signature checks on the webhook routes remain in their handlers; after verification, those handlers use internal counterparts.

## Evidence

1,240 tests passed, 14 skipped across 95 files. Next production build and Convex backend typecheck passed. Counterpart tests compare actual SDK validators and invoke the original behavior while the owner-protected public handler rejects the same unauthenticated context. Unknown registrations and mismatched function kinds cannot acquire an internal counterpart.

The deployed Convex function specification confirms all 45 counterparts exist with internal visibility and exactly the same arguments, returns and function kinds as their public versions. Native privileged settings reads succeed. Actual unauthenticated query, mutation and action RPC requests to representative internal counterparts are rejected as non-public before handler execution. The actual Lab model conversation passes with a saved accepted draft and successful send dry run; its booking stays unchanged and its owned fixture is cleaned.

Proofs: `/root/rental-internal-callers-native-validators-proof.json`, `/root/rental-internal-callers-native-boundary-proof.json`, `/root/rental-internal-callers-source-proof.json`, `/root/rental-internal-callers-model-proof.json`.

## Remaining authorization work

Operational owner enforcement remains off. The original public registrations remain publicly callable in that staged mode. Next website routes, Trigger/server client identities, frontend access handling, owner setup and recovery still require migration and verification before cutover. The source check covers the current Convex runtime sources, not external workers or arbitrary dynamically generated code. Real Hygglo activation, automated renter messages and booking writes remain separately gated by explicit written consent.
