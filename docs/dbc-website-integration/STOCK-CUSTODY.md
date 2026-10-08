# Storefront physical custody — 8 October 2026

`reservations:listActiveForStorefront` previously selected only rows ending yesterday or later. An older rental still marked DELIVERED therefore disappeared from the website mirror, although its equipment had not returned.

The source now merges that dated index with the account-specific DELIVERED index, deduplicating by reservation ID and retaining only confirmed, non-obsolete delivered records in the additional slice. Its existing minimal equipment/date projection remains unchanged; customer contact data is not added. The new `by_account_order_step` index avoids reading other accounts' delivered history.

The paired website source preserves delivered custody as active stock and uses one occupancy calculation for listing/cart availability, replacement checks and checkout holds. An overdue active interval has no reliable future availability until return is recorded; its saved planned dates are not rewritten. Returned/completed source rentals no longer occupy mirrored stock, including early returns.

An actual manager handler regression verifies old DELIVERED records, dated/delivered deduplication, foreign/cancelled/obsolete/returned exclusion from the added slice and the safe projection. Website handler tests cover the real mirror transformation and stock/alternative/hold checks. These use synthetic databases/provider transport. No live deployment or financial/customer messaging is performed by these checks.

Deploy the compatible manager index/feed and website source together before live acceptance. This change does not prove cross-project atomic reservation claims: the website still validates checkout holds against its locally mirrored ledger. The original distributed double-booking requirement and secured owner/provider acceptance remain open.
