# Private identities for rental background workers

The scheduled Hygglo poller, catalog sync, competitor sync, listing-info worker,
and model scanner previously used anonymous Convex HTTP clients. They now use
one private deployment-key transport with the reserved service identity accepted
by the backend owner guard. The client rejects browser execution, missing private
credentials, and any URL other than the current rental backend.

Trigger production received private CONVEX_DEPLOY_KEY and CONVEX_URL variables.
The build environment sync preserves these settings on future releases. No
credential is exposed in NEXT_PUBLIC variables or browser code.

The on-demand rental-service-health task makes a read-only internal identity
check. The check calls authorization directly, independently of the transitional
OWNER_AUTH_REQUIRED switch. It neither reads nor writes Hygglo.

Validation: 1,243 tests passed, 14 skipped; actual Convex admin transport proved
service authorization on hearty-oyster-600. The Next production build passed.
Trigger production version 20261003.3 completed run
run_06gg0fas7o2ad7kbuklq9hng01, returning authenticated_service=true, the
canonical backend URL, and read_only=true. Provider environment list values are
redacted, so the real worker run is the evidence that its credentials work.

Owner enforcement remains disabled until website API callers, owner onboarding,
and recovery are ready. This phase does not close anonymous operational access.
Real Hygglo chat activation and booking/message writes remain disabled and require
Daniel's separate explicit written consent.
