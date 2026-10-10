# Quick Reply regression checks

Run `npm run test:quick-reply-ui`. Node builds the **actual ReplyInbox component and CSS** with a fixture-only Convex transport, serves it on a private loopback port and starts a temporary Chrome profile with external DNS disabled. It never opens a real renter or changes any provider data. Unknown actions fail closed.

The pointer tests cover toolbar/filter/sort controls, account quick texts, reviews, AI previews, test sends, booking add/remove/price/refund/date actions, approval/decline, replacement draft/acceptance and website progress updates. The mobile checks cover composer, quick-text editor, calendar and reviews at 320/390/768/1100 widths, including landscape and a mocked `visualViewport` shrinking to 390px with an 80px keyboard offset, checking both the close hit target and Send visibility. The JSON receipts record each control assertion and the 32 close/viewport scenarios. It does not claim physical iOS/Safari qualification.

Set `RM_QA_OUTPUT` to retain the JSON receipts. These tests deliberately use fake transports; actual replacement handlers, stock races, immutable snapshots and replay/recovery are tested separately in the Convex tests and DB Cinema's `test-quick-reply-replacements.cjs`.

Reference photographs and generated bundles are **not** application assets. Visual comparison screenshots from this release are retained in `/root/CODEX_ARTIFACTS/rental-manager/quick-reply-reference-2026-10-10/`.

The current control suite also checks that the production Test mode switch is absent, sends use normal arguments through the isolated transport, unavailable requests cannot be approved, list-row replacements prepare two options, and desktop conversations expand to half the workspace. No production client is constructed and external DNS remains blocked.

Rental controls are tested as an actual desktop drawer and mobile sheet. Tabs, source booking links, both replacement choices, explicit approval, separate sending, fixed message review, and close targets use real pointer/touch events against fixture transport. Replacement approval is asserted never to send a message.
