# Private shared stock projection

The authenticated storefront route now allowlists items:sharedStockForStorefront with exactly empty arguments. An actual typed internal query reads loadStockSources in one snapshot and projects only master IDs, active/current capacity and numeric occupancy windows. It exports no account, renter, order, case or message data. Public owner authentication remains intact.

The existing quote implementation and exporter share stockOccupancyForItem: all shared-account confirmed/ongoing rentals, physical kit allocation, extension maxima, independent rentals, overdue custody and per-item periods use the same calculation. Website booking copies are excluded only from export to prevent counting their local reservations twice. Repair holds, owner blackouts and active vacations enter the same sparse window projection. Terminal rentals/cases and inactive vacations do not occupy stock.

Numeric windows encode the manager's London wall-clock quote coordinates for the website's full-day rental checks; they are not new calendar timestamps. Half-open ends retain the actual quote return buffer, including its carry across midnight. No agreed booking dates are rewritten.

The paired website action requires the canonical snapshot, atomically replaces upstream occupancy/current capacity and rejects malformed, stale or conflicting receipts before freeing stock. Its site/subscription reservations remain local. This closes the prior source gap, reproduced through real authenticated HTTP against the previous actual website importer with controlled inventory. Tests cover actual quote parity and individual constraint release. Full checks and source-matched hosted evidence will be recorded after completion.

The website also prevents a slower catalogue read restoring historical capacity after a newer stock receipt. New physical mappings await verified capacity; unchanged cached receipts can reconcile them safely. Its unused older mirror mutation has no runtime caller and is removed.

Backend publication, live shared-stock/cart acceptance, credential/owner setup, legacy allocation reconciliation, freshness and a shared atomic claim across all writers remain pending. No live provider writes, messaging, payments or production rollout have been enabled.

Full local validation passes: 141 files / 2159 tests / 14 skips, TypeScript, Next build and both owner audits. The paired website full default suite/typecheck/build passes. Both graphs are updated. Hosted manager CI 37732363731 for 460a6bd and website CI 37732364129 for 315f732 are terminal SUCCESS; the website includes complete membership/cart/checkout browser regression. Matching previews dpl_HcsSjCbG6r9GbAgzUa9opGW6EMMV and dpl_4ZuuLAkUgjHYyTvkrimEBRuBoSJU are READY. Backend publication and live provider acceptance remain separate.
