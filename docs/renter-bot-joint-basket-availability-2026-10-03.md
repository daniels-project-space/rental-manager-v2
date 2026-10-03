# Joint recommendation availability

A Lab reply offering a Remus 100mm lens and PL-to-L adapter had genuine separate availability receipts, but said “Both are available.” The guard treated that reference as the last item. Accepting separate successes would also miss shared physical stock consumed by multiple proposed extras.

The bot now has a read-only `check_basket_availability` tool wired to Native inventory. It resolves all proposed items, retains the current booking for additions, or removes an exact selected listing for a replacement, and checks the aggregate physical components in one database snapshot. Server scope supplies the current account and thread even when omitted by the model. Confirmed bookings cannot use standalone checks to bypass their existing basket.

Native component receipts retain the complete basket verdict and aggregated physical counts through draft persistence. The guard resolves consecutive exact item bullets and explicit coordinated names, requires joint positive evidence for group promises, preserves dates and quantities, and distinguishes directional adapter mounts. Unknown members, unrelated intervening prose, different mounts, partial baskets, and separate successes cannot qualify a group. Negative group claims still require negative evidence for every member; a failed basket does not imply every component is unavailable.

At send time the persisted aggregate physical requirements are checked again against one current Native stock snapshot. The earlier basket verdict is replaced rather than reused. Booking context and existing send gates remain in force.

Validation:

- Full suite: 1,196 passed, 14 skipped, 91 files.
- Native isolated Lab proof `/root/rental-joint-native-proof.json`: confirmed FF retained; Remus and PL-to-L proposal available with one adapter; two additional Pro kits require 15 NP-F570 batteries and are rejected against the recorded conservative pool of 12. Standalone bypass unknown. Order unchanged. Fixture cleaned.
- `/root/rental-joint-replay.mts`: original saved model reply's stock assertion passes with the actual new joint Native receipts; separate receipts remain insufficient in regression tests.
- Backend typecheck and Next production build passed. Graphify update preserves the known partial extraction warning for `audit_qty_drift_data.ts`.

This does not establish overall production readiness. Fresh model behavior, requested Great Joy refusal grounding, more conversational group formats, combined addition prices, catalogue mapping review, and the broader stage audit remain separate acceptance work. Real Hygglo messaging and booking actions remain disabled pending explicit written consent.
