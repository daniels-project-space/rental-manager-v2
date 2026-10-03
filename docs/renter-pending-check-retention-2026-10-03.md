# Pending owner checks remain visible

The shared bot context previously read the latest twenty owner-check records for a thread. Handled tasks could displace an older pending task, causing both bot context producers to omit unresolved work.

`ownerChecksForBot` now loads all pending tasks through the existing status/thread index and separately loads the latest twenty handled tasks. Pending tasks appear first. Scope, context-change markers and unverified specification status remain intact; private handling notes are excluded. The draft route prefetches `renter_bot_tools:get_renter_context` and includes its owner-check array in the model context; the SDK tool also exposes it.

Validation: 27 focused registered-handler/context tests, project and backend typechecks. Deployed acceptance uses an owned Lab conversation with one original pending check and twenty-one newer handled checks. It verifies the deployed getter and actual SDK schema retain the original pending task, the booking remains unchanged and fixture cleanup succeeds. No model call or real Hygglo write is required.

This addresses task retention; it does not establish recommendation quality or owner confirmation of equipment specifications. Real Hygglo messaging remains disabled.
