# Request identities through website APIs and renter tools

Dashboard/chat, WallE, push-subscription save, and Lab comparison API requests now
use a shared owner-session wrapper. It obtains the real Better Auth token, checks
live owner membership through auth:state, and forwards that token to fresh Convex
clients throughout the request. Missing, expired, or non-owner sessions stop the
handler before paid model calls when OWNER_AUTH_REQUIRED=true. Authentication
outages and invalid rollout configuration fail closed.

Secret-protected draft and listing endpoints retain their existing private-secret
checks and use deployment service credentials for their backend work. Public
poller health and VAPID endpoints expose only their existing minimal status/public
key output. Mastra tools inherit the verified request identity through Node async
local storage rather than constructing anonymous clients. The dormant background
draft workflow uses the private worker transport. The vacation-conflict drawer
uses the authenticated React provider client for its on-demand check.

The Lab comparison endpoint now rejects real chats, account/message mismatches,
stale messages already answered by the owner, and malformed input. It stops when
canonical generation fails or skips. Its raw candidate is explicitly unreviewed
and cannot invoke booking-change tools. The canonical branch remains the normal
Lab drafting path; this comparison is not a side-effect-free sandbox clone.

Validation: 1,258 tests passed, 14 skipped, 99 files; production Next build passed.
A real temporary owner session proved anonymous rejection, valid owner forwarding
to chat/push handlers, revoked-cookie rejection, continued prohibition on real
chat activation, and private service access for public health/VAPID output with
local Next enforcement enabled. All auth fixtures and their invitation were
removed and the original empty owner table restored. No actual renter writes.

The CI owner check now also rejects raw HTTP client imports, dynamic SDK loading,
and private service imports in browser components. Three injected unsafe source
cases were rejected and removed. Current source checks pass.

Production enforcement is still disabled. Both deployment flags must be
coordinated after owner onboarding, frontend gate/logout/recovery, and persistent
push renewal authorization are ready. A session-only renewal path still needs
work before enforcing login: an expired login must not permanently stop a phone
subscription from healing. Anonymous operational access is not closed yet.
Real Hygglo activation, booking changes, and messages remain disabled until
Daniel gives separate explicit written consent.
