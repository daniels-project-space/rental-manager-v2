# Deployment cost and cache operations

## Production release boundaries

`deployment-inputs.json` belongs to this repository. Regenerate it with
`node scripts/deployment-inputs.mjs --write` after staging new runtime files.
CI checks the generated result. Unknown inputs, missing manifests and missing
Git history cause normal builds. `VERCEL_FORCE_BUILD=1` also forces a build.

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

The existing daily 03:17 UTC backup remains authoritative and serialized.
It validates Rental Manager's current vault credential source before exporting,
then resolves current storage credentials immediately before uploading directly
from the runner to its existing R2 bucket and backup key. It does not depend on
the old separately copied GitHub R2 secrets, persist credential files, or forward
the backend/vault credential to the storage uploader.

The upload supplies a Content-MD5 checksum and records the source SHA-256.
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
