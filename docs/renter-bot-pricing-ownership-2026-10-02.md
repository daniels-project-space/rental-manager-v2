# Reject pricing for explicitly unrentable listing components

Native inventory showed zero units of the Great Joy 35mm, 50mm and 85mm lenses, but their nonempty legacy override still admitted Leo product 1122324 into the pricing candidates. Both the full imported camera-kit title and an exact product ID could return a £220 two-day quote. A nonempty mapping establishes an association, not current ownership.

The account-listing quote path now rejects `loadListingInventory(...).owned === false` before returning a usable price. This uses the shared physical-component rules for inactive, marketing-only, zero-quantity and deliberately empty mappings. Unknown mapping completeness is not silently reclassified as false; temporary date-specific reservations remain a separate stock check.

Read-only Native verification after deployment refused both exact-ID and exact-title requests for product 1122324 with `not_rentable` and no total. The owned Pro product 1172895 still returned its Native £70 two-day price. No inventory, listing or renter records were changed by this probe. Full regression suite, build, backend typecheck and exact app release are recorded with this audit phase's receipts.
