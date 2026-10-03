# Price completeness review — 3 October 2026

A real lab reply correctly explained that the TTArtisan is manual focus, acknowledged an owned Sony lens and deferred an alternative quote until its specifications and availability could be confirmed. The review still raised `CONTRACT:price-figure`.

The legacy review classified any renter message mentioning a quote as PRICING_INQUIRY. Any recorded item price then required a pound figure in the response, even when that price belonged to the existing rental rather than the alternative being asked about. An unrelated or meaningless pound figure could satisfy it. A later text-pattern exception for stock declines did not address the underlying scope error.

Removed that superficial price-presence obligation and its decline exception. Other intent contracts remain, and every actual quoted amount is still checked against Native item, date, quantity and purpose evidence. This change does not claim to implement semantic quote completeness: that needs the resolved desired request and a scoped quote outcome, rather than any price in the prompt.

118 focused guard tests pass, including the truthful partial reply, rejection of a fabricated £99 for a Native £42 rental, and acceptance of the correct quote. Backend typecheck/deployment passed. A registered-handler replay of the saved actual model reply uses deployed Native reads/writes and a controlled API response, checks saved approval and dry-run sending, leaves the test order unchanged and cleans up its own fixture. This is a replay, not a new model turn. No new paid model calls or real rental writes.

Open: assess scoped answer completeness across quote, availability and technical questions; verify that unresolved parts reach an owner workflow while answerable parts remain useful. Full production readiness, owner access cutover and the broader bot audit remain incomplete. Real Hygglo messaging or booking execution still requires separate explicit written consent.
