# Read-only date offers and exact acceptance

A Lab date-edit call previously checked stock but could change the period and price after an unrelated renter question. Date changes now require the latest real renter's precise dates and price agreement, or clear acceptance of an unchanged quote saved on the actual previous owner message. A clear date instruction with no cost increase can proceed directly. Stale basket/price context, wrong dates/prices, questions and unanchored references leave the booking unchanged.

The new quote_booking_dates tool reads the complete current basket, captured Native price tiers and all physical kit components for the full proposed period without writing. Accepted edits perform the same checks again atomically. Owner messages archive exact offers only from the current approved saved draft and Native booking context. Retry returns the current order without another edit.

Price evidence preserves the complete new total, original quote context and per-line Native totals. Extension adjustments are checked against the difference between full totals and cannot certify that difference as the booking total. Actual Native tier receipt regression: £124 for two days becomes £170 for three; its approximate displayed £56.67/day does not imply £170.01. The validator uses raw captured tiers and the shared Native whole-pound policy.

Validation: 228 focused checks across seven files, followed by four focused price-adapter checks after the actual Native rounding case exposed a defect; frontend build and backend typecheck/deploy passed. The disposable deployed fixture uses a synthetic saved offer, no model call and no real rental writes. Its proof is /root/rental-date-native-proof.json. Graphify updated.

Still open: date-edit confirmation recovery after a rejected generated reply; broader natural-language date forms and comparative date quotes; structured multi-item removal offers and remaining-kit compatibility; owner auth cutover and durable phone push. This is a completed date-contract phase, not completion of the broader audit or authorization to activate real Hygglo chats.
