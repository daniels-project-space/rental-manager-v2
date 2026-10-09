# Catalogue contents and physical stock

The catalogue sync retains the full description from the exact product-detail
response. A missing detail description preserves the previous value; an explicit
empty description clears it. Product identity is checked before upsert. Current
product descriptions take precedence over the legacy online-listing cache.

`listing_components.ts` resolves the advertised kit against existing master
inventory. Fully structured, unambiguous contents may derive or expand a kit
mapping using active, explicitly owned master records and exact declared counts.
This computes requirements; it never increases inventory quantities or changes
saved owner mappings. Empty owner overrides remain exclusions. Unknown models,
ambiguous identities, missing ownership metadata and invalid quantities remain
incomplete. Protective caps and cases do not create extra equipment pools;
tracked filters, mounts and other genuine equipment still consume stock.

`canonical_listing_allocation.ts` applies that same resolution to occupied
rentals. Shared availability, calendar views, returns, draft stock checks,
missed-revenue occupancy and the website rental export use it. Occupancy readers
fetch descriptions by the exact distinct booked listing keys, rather than
parsing the full catalogue on every query. Shared-stock snapshots compute each
rental's canonical units once and reuse them across inventory rows. Existing website
per-item allocations remain frozen. First-row overrides match indexed listing
readers, including an explicit empty exclusion in duplicate legacy rows.

Lens identity matching preserves focal ranges, stated aperture and generation,
manufacturer and known mounts. Equivalent G Master, unit and Unicode dash
spellings are normalised. Missing model details are not filled by selecting a
different stocked model.

Regression coverage exercises the actual catalogue, stock and rental export
handlers, known physical capacity, exclusions, frozen website allocations,
failed detail reads, and genuine kit accessories. A public-source snapshot audit
is separate from live availability: a complete owned mapping alone does not
prove that the equipment is free for a requested period.
