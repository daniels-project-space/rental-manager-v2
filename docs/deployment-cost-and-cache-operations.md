# Deployment cost and cache operations

## Production release boundaries

`deployment-inputs.json` belongs to this repository. Regenerate it with
`node scripts/deployment-inputs.mjs --write` after staging new runtime files.
CI checks the generated result. Unknown inputs, missing manifests and missing
Git history cause normal builds. `VERCEL_FORCE_BUILD=1` also forces a build.
Shared package/compiler settings affect every layer. Release-control scripts
follow their actual website/backend-publisher consumers and do not by themselves
require publication of an unchanged worker image.

With `RM_SPLIT_DEPLOYMENTS=enabled` in GitHub and Vercel:

- Backend-only main changes publish through validated GitHub CI; the website
  build is skipped by the project-specific ignored build step.
- Website-only changes build normally and reuse the served backend when its
  complete source fingerprint is unchanged.
- Mixed website/backend changes publish through the Vercel build.
- CI publishes changed Trigger dependencies after validation and verifies that
  their compatible backend is actually served. The manual task workflow remains
  available; do not create a second automatic publication path.

The website and backend may legitimately have different Git commits. Verify
their actual input equivalence, canonical alias and private backend identity;
do not infer production health from a successful push or command alone.
An ignored Vercel deployment is reported as canceled: its build log must show
that the ignored build command returned zero, rather than a failed build.

Publishers share one indexed reusable lease with a bounded expiry and heartbeat.
Owner and source commit must match for acquisition, renewal and release. A lost
lease stops the command group before release. Production freshness checks use
this public repository's pinned URL in Vercel, where clone-local `origin` may be
unavailable; GitHub uses its authenticated checkout. Superseded source still
fails closed. Do not overlap an uncoordinated manual Convex push with Git builds.

## Local and runtime caches

The render asset cache retains at most 64 MiB and 32 entries for one hour.
Expiry is lazy, active loads are coalesced within a bounded pending-key map,
and oversized or overflow requests still receive their complete buffers.
Replacing a key replaces its byte accounting as well.

Compiler scratch created by the publisher uses owned `.convex-tmp-*` folders
that are removed after success or failure. An explicitly configured
`CONVEX_TMPDIR` is preserved. Build helpers invoke installed tool entry points;
they must not install packages implicitly or rewrite a shared dependency tree.
Use frozen installation in a project-owned dependency directory. Do not prune
shared stores or delete an active worktree's dependencies as cache cleanup.
`graphify-out/`, development metadata and compiler scratch are excluded from
runtime/deployment inputs.

## Backups and credential rotation

Backup helpers live in `.github/scripts/`, outside application runtime inputs.
Ordinary edits there do not rebuild the website or publish workers. A helper
imported by real runtime code remains a deployment input; CI checks that boundary.

The existing daily 03:17 UTC backup remains authoritative and serialized.
It validates Rental Manager's current vault credential source before exporting,
then resolves current storage credentials immediately before uploading directly
from the runner to its existing R2 bucket and backup key. It does not depend on
the old separately copied GitHub R2 secrets, persist credential files, or forward
the backend/vault credential to the storage uploader.

The upload supplies a Content-MD5 checksum and records the source SHA-256.
Optional automatic SDK checksums are suppressed so R2 receives one explicit
validated checksum, rather than rejecting two simultaneous checksum headers.
The existing HeadObject check verifies complete length and matching SHA-256
metadata; the receipt identifies the exact object. Cloudflare documents
[Content-MD5 support for PutObject](https://developers.cloudflare.com/r2/api/s3/api/).
The temporary exported snapshot is removed even if a job fails.

For credential diagnosis, dispatch the backup workflow with
`verify_storage_only=true`. That mode does not install packages, export data or
upload objects. It proves credential resolution/configuration, not object-write
permission. A completed actual backup and verified R2 receipt are required for
end-to-end acceptance. Inspect a failed phase before retrying an export.

## Qualification and spending

Full repository typechecking and contract tests remain in CI even though Next
uses a website-specific TypeScript program. Prefer offline production fixtures
and natural scheduled task runs over paid AI/GPU/media tests. Preserve models,
cadence, latency, recovery and publication gates. Keep the approved team blocking
budget and pause policy. Use Git deployments, inspect their exact source and
alias, and avoid duplicate CLI builds. Report observed compute separately from
estimates or realized billing savings.

## Qualified operational checks, 17 October 2026

- An actual backend-only release skipped Vercel installation and compilation,
  while CI published the new backend and retained the unchanged website artifact.
- The website build path also completed while reusing an unchanged served
  backend. Both canonical alias and actual backend fingerprint were checked.
- A normal hourly poll completed in 30.939 seconds of provider-reported compute,
  compared with 45.383 seconds for the preceding hourly run. All three accounts
  succeeded with similar message counts; naturally arriving traffic differs.
  This observation is not a universal runtime or invoice saving guarantee.
- The recovered daily backup was read back from its private R2 object. Its
  complete SHA-256 matched the source receipt and all ZIP entries passed CRC
  validation. Runner export cleanup succeeded; no backup file was retained on
  the VPS. Credential-only preflight did not export or upload data.
- The three guarded VPS maintenance timers were active. The approved team
  blocking budget and pause threshold were read back unchanged.

Local contracts include the installed SDK's actual serialized request headers
and the current project manifest, alongside offline production-data fixtures.
Operator acceptance still requires native provider and object evidence.
