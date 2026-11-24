# DB Cinema shared stock write path

This service accepts private stock claims from the DB Cinema Convex deployment at `POST /dbcinema/shared-stock`. The public availability feed remains read-only. The write endpoint accepts only the fixed DB Cinema operation protocol and requires a shared secret.

## Required configuration

Use the DB Cinema manager URL ending in `/dbcinema/booking-sync` for `RMV2_WEBHOOK_URL`; the website transport derives `/dbcinema/shared-stock` from that canonical URL. Configure the same high-entropy secret as `SHARED_STOCK_WEBSITE_SECRET` in DB Cinema and `DBCINEMA_SHARED_STOCK_SECRET` here. Do not put secret values in source control or this document. Both apps must be deployed before the site bridge is enabled.

## Claim lifecycle

- `acquire` checks Rental Manager owned stock, active bookings, repairs, blackouts, vacations, and other active website claims in one mutation. Item changes send only net-new units; a new paid booking sends its full basket.
- Paid website booking claims are tied to the booking ID. When the booking sync imports identical physical windows, Rental Manager closes that claim in the same mutation so the booking is counted once.
- Item-change claims remain active while the website changes are settling. They are closed only after the synced booking revision and physical windows match the change receipt. A mismatch returns a stock-risk receipt and keeps the claim active for recovery.
- `releasePrepared` is limited to claims that have not begun execution. Compensated releases require the website's successful refund evidence and an unchanged, matching booking.
- Claims are retained as idempotency/audit receipts. Active claim reads are bounded; exceeding the safety limit fails availability closed instead of dropping claims.

The DB Cinema application retains its existing disabled swap-authority guard until the complete site stock-writer inventory and end-to-end cross-app tests prove every relevant path. Adding this endpoint does not enable website swaps by itself.
