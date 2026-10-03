# One Native quote for multiple additions

The model correctly quoted a Remus lens at £50 and a PL-to-L adapter at £20, but a £70 combined addition and £194 proposed booking total lacked a real combined receipt. Separate one-item previews cannot prove one complete proposal.

`quoteAdditionBasket` is a read-only Native query for one to eight exact offering IDs. It retains captured terms for the existing order, loads each selected offering's verified owned mapping and current listing tiers, combines identical additions and commercial lines, and checks all physical components in one stock snapshot. It returns the unchanged base quote, the whole addition quote, and the proposed full quote. Unmapped or unpriced offerings, insufficient stock, empty existing baskets and closed rentals fail without changing the order. It refuses non-Lab threads.

The existing `quote_booking_addition` tool now accepts an items array for this query. The single-item preview path remains supported. Price evidence validates exact members, inclusive dates, line terms and arithmetic before issuing a group addition receipt. The guard binds collective costs and conditional full totals to the named quoted members and current base basket. Distinct members cannot be replaced by repeated names. Directional adapter aliases preserve both mounts.

Validation:

- Full suite: 1,205 passed, 14 skipped, 91 files. Backend typecheck and Next production build passed.
- Actual Native isolated session (`/root/rental-combined-quote-native-proof.json`): base124, lens50, adapter20, additions70, proposal194. No booking changes. FF plus two Pro kits exceeds the recorded battery pool and returns no quote. Unverified Great Joy/Pro offering1112159 returns no quote. Session cleaned.
- Original actual model reply replays successfully using real new Native receipts (`/root/rental-combined-quote-replay-proof.json`). Regression fixtures retain the actual Native quote's terms; they are test inputs only.
- Regression checks reject wrong amounts, quantities, members, mounts, dates, threads, failed proposals and inconsistent marginal parts. Graphify updated with its known partial AST warning for `audit_qty_drift_data.ts`.

This quotes additions for the existing date span. Prospective date changes, exact multi-focal set resolution, more conversational price formats, atomic acceptance of multiple extras and the broader stage audit remain separate acceptance work. It does not activate real Hygglo chats or booking writes; those remain gated by explicit written consent.
