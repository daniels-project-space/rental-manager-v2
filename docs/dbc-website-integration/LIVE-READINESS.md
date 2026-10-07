# Live private integration preflight

Run `node scripts/check-dbc-live-readiness.mjs --website-url https://<verified-live-deployment>.convex.cloud` from this project. Independently inspect the public website's current Convex client binding first; the script requires that binding explicitly so a historical development URL cannot silently become the production target.

This check reads the operational `hearty-oyster-600` deployment and the specified website deployment. It checks the private owner record, owner enforcement, website URL and matching server credentials. Credential values and hashes are never printed. Missing/unreadable flags are reported as `null`, not as a verified literal `false`. Exit 1 means integration blockers; exit 2 means invalid arguments. It does not deploy, import records, change flags, register an owner, execute payments or send email. Passing the check does not authorize financial execution.

## Read-only receipt, 7 October 2026

At 23:09 UTC, the actual public DB Cinema client used `zany-wolf-18.convex.cloud`. Vercel showed DB Cinema deployment `dpl_CGfJpXK59LhhEA45ZEioBm2WdBWT` READY on the production domains, source `c01f0ee3820b6379b8d10b71a6aa08f1dd567f89`; Rental Manager deployment `dpl_9EeDemr78jNbFHZYehmRKAjvRx13` was READY on its production alias, source `bc924afdcac7877b47c04501e95b6e9ee0b1a423`. These live facts supersede historical workspace notes. Sensitive Vercel environment metadata does not reveal its values; an absent value in the API response is not evidence of a missing key.

The actual preflight exited 1 with four blockers:

- No registered owner/auth binding in Rental Manager.
- `OWNER_AUTH_REQUIRED` unset/unreadable; owner protection is not enforced by default.
- Manager `DBCINEMA_CONVEX_URL` points at `veracious-wombat-196.convex.cloud`, rather than the live website.
- Manager website admin credential does not match the specified live website credential.

`ALLOW_WEBSITE_RETURN_WRITES` was also unset/unreadable. No backend configuration, private customer imports, financial execution or emails changed. Preserve the private-case import guard until an owner session is verified and owner enforcement enabled. Then pair the compatible website/manager deployments and matching server credential, and verify public availability callers before proceeding to live acceptance. Owner setup requires the private invitation; the invitation hash alone cannot recover it.
