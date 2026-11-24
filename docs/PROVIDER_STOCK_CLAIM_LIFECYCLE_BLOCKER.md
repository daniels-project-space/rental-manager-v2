# Provider stock claim lifecycle: release blocker

The current approval claim is prepared transactionally before a Hygglo approval
attempt. It must remain reserved if the provider response is missing, rejected,
uncertain, stale, or does not prove that the physical equipment was returned.
The current stock calculation reads at most 501 approval claims and fails closed
above 500, including historical claims. This is safe but is not scalable.

## Why existing rows cannot safely release claims

- `stock_approval_claims` has no durable state or provider outcome receipt.
- `order_step: REVIEWED` is not enough evidence: both active-step extraction
  paths can store the active `REVIEWED` step without recording whether the
  provider's `RETURNED` step is explicitly completed and not failed.
- Reservation rows can also be changed by administrative or import paths.
  A stored order step therefore does not preserve the source, freshness,
  identity, or evidence necessary to distinguish a verified provider return
  from an inferred or manually written state.
- A failed, timed-out or rejected approval response does not prove that the
  provider failed to accept the request or that equipment was never handed over.
  Dates, cancellation and absence from a poll are not return evidence.

Do not bulk-mark legacy rows as released, remove the 501-row guard, or infer
return from an elapsed period. Those shortcuts can make unreturned equipment
bookable and create double bookings.

## Safe completion path

1. Introduce a server-only authenticated provider reconciliation action that
   fetches the exact account and order directly and records immutable evidence:
   provider identity, account, order, observed time, source revision or receipt,
   and an explicit completed, nonfailed `RETURNED` step. Resolve contradictory,
   stale, absent, or unauthenticated evidence to `needs_review`, never release.
2. In the same transaction that verifies the matching claim and evidence, move
   the claim from a stock-holding state to a terminal returned state. Keep the
   claim as an immutable idempotency/audit receipt. A replay must be harmless;
   concurrent and out-of-order results must not revert the terminal decision.
3. Add a state index and use bounded indexed reads of stock-holding claims in
   every availability, preparation, quote and cached-stock path. Validate
   unknown states and overflow conservatively. Preserve exact matching-mirror
   deduplication and overdue-custody handling.
4. Migrate legacy claims in bounded, restartable batches. Reconcile each against
   fresh direct provider evidence; unknown or conflicting cases stay active and
   appear in an owner review queue. Do not classify old rows from stored
   `order_step` alone. Maintain a durable migration cursor and verify counts.
5. Exercise actual handlers for success, rejection, timeout, retry, duplicates,
   stale/out-of-order updates, simultaneous claims, partial migration and more
   than 500 historical records, including the reverse race with a new booking.
   Verify provider credentials and response semantics in an isolated environment
   before enabling the indexed lifecycle or removing the current safety limit.

## Fresh poll evidence audit

Fresh evidence can in principle be captured at the provider GET boundary, but
the current poll-to-database path cannot yet establish it as an authoritative
receipt:

- `src/hygglo-core/poll.ts` fetches order details and calls
  `providerReturnCompleted`, but the normal non-denial payload discards the raw
  order and transports only `order_step_extracted`. The legacy adapter in
  `src/trigger/poll-hygglo.ts` has a separate extraction path. Both produce
  `REVIEWED` either from completed-return evidence or from an active step.
- The poller skips unchanged non-current details and can omit an order when its
  detail request fails or the order has no rental dates. A lifecycle relying on
  ordinary poll output would therefore miss claims indefinitely; absence from
  the list or an unchanged activity stamp is not evidence of return.
- `hygglo.upsertOrdersAsReservationsBatch` accepts an extracted step or raw
  order from callers; it is not a provider-attested receipt. The owner wrapper
  also depends on the deployed access configuration, and admin/backfill paths
  can write the same reservation fields. Adding a caller-supplied boolean to
  that mutation would not prove the provider returned the equipment.
- `providerReturnCompleted` recognizes a `RETURNED` step with `completed: true`
  and no explicit failure. The supplied payload contains no established signed
  provider revision or return timestamp. An implementation must bind the
  response to the exact authenticated account and requested order, record when
  it was fetched and the minimal validated evidence, and fence races against
  approval attempts created after that fetch. Persisting an unbound raw order or
  `REVIEWED` value is insufficient.

The next safe implementation should use a dedicated bounded reconciliation
queue of active claims. Its trusted server worker must fetch each exact order,
verify account/order identity, and submit evidence via an enforced,
service-authenticated boundary. The claim mutation must atomically compare the
claim generation and preparation time before transitioning it. Replay and
older receipts cannot resolve a newer claim; all uncertain outcomes remain
active. The worker must not depend on the normal poller's skip optimization.
The state index, migration, retry limits and cross-path regression suite listed
above must land together before the current stock guard can be changed.

No live provider calls, claim changes, deployment or production data changes
were made as part of this audit.
