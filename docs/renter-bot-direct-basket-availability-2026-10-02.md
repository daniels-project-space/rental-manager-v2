# Direct availability uses booking scenarios

A confirmed Lab booking already contained a Full Frame kit and a Pro kit. The direct stock tool checked another Pro alone and returned available (Pro1 / NP-F5705), while the real addition preview correctly refused the complete basket (Pro2 / NP-F57015, against owned Pro1 / conservative NP12).

The direct query now checks current gear, additions and exact-listing replacements as distinct read-only scenarios. Proposed changes reuse the complete-order stock checker. A confirmed basket cannot be bypassed with standalone mode, and current mode cannot override an explicit addition/replacement request from the latest stored renter message. Server prefetch and the Lab date panel explicitly check the current basket; their context flag is not part of the model tool schema. Agreed pickup/return times still reach the shared stock engine.

Existing-booking prefetch remains visible to the bot, but its receipts are excluded from proposal grounding when the latest request clearly asks for an addition or replacement. The model must obtain proposal stock evidence. The Lab panel uses the same current-basket query and handles optional component results safely.

Native probe: additional Pro refused with Pro2 / NP15; current basket accepted with NP10; standalone and model-current bypasses returned unknown; exact replacement of Pro with FX3 accepted with retained FF / NP5; a subsequent current-gear question remained available. Order unchanged after all read-only checks, probe cleaned. Six planner tests cover the scope distinctions. Full suite: 1,181 passed, 14 skipped across 91 files. Backend typecheck passed. A build caught an optional-array assumption in the Lab panel; corrected build and exact alias/model acceptance are recorded separately.

Limits: addition/replacement wording inference covers explicit common phrasing, not every possible conversational intent. The broader unavailable-Great-Joy evidence and other advertised-bundle mapping audit remain open. Real Hygglo messaging and booking execution are not enabled by this change.
