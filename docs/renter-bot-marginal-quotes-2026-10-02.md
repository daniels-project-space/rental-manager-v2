# Extra-unit prices, offering identity and false kit refusals — 2 October 2026

The wider production-readiness audit remains open.

## Root causes and changes

`applyChange` merged additions using a physical item ID. That ID does not identify a priced offering: one camera can appear in a body-only listing and many kits, or have a booked rate different from the current rate. Additions now carry the selected standalone listing ID and merge only matching offering IDs and captured pricing terms. Existing kit quantities and booked prices remain intact. The preliminary check concerns the requested extra; the transactional complete-basket check counts existing kit components and extras together.

Proposals include `base_quote`, `addition_quote` and `additional_cost_gbp` alongside the full `quote`. The evidence adapter validates dates, duration, quantities, Native identities, rates and sums. An existing booked line or merged two-unit line cannot certify the cost of one extra. Current already-booked extras can still be priced from their current-order receipt. The tool instructs the model to distinguish extra cost from the new total. A proposal never attests a booking edit.

Live leo FX3 descriptions exposed false stock refusals. In `1097510`, the contents heading had no colon before the packing list; the parser consumed the list up to a later “Please kindly note:” policy sentence. The heading now stops at an explicit quantity marker, and that note ends the contents block. Generic camera cages retain the existing incidental-accessory treatment. In `1122295`, the explicitly optional XLR handle is excluded from mandatory stock. Native kit completeness stays partial.

The price contract required a currency figure because it saw a prefetched booking price, even when no suitable addition could be supplied. This review annotation is suppressed only for a decline with a Native negative stock receipt for the same dates and named subject, without offering an available alternative. Positive offers, unrelated receipts, changed dates and failed checks still flag missing pricing. Stock, ownership, currency and optical guards stay independent.

## Evidence

- 1,129 tests pass; 14 skipped; 86 files. Next production build and Convex typecheck/deploy pass. Graph updated; the pre-existing Graphify extraction warning for `convex/audit_qty_drift_data.ts` remains.
- Native body and lens-kit proposals previously failed `listing_not_rentable_or_unmapped`. They now succeed with the original kit unchanged and a separate £98 body for 20–21 October. A £130 kit proposes £228; a £98 body booking proposes £196; a £160 two-body kit proposes £258. Previews made no edits; owned probes cleaned up.
- Native same-item check: a two-camera £196 Lab booking proposes one extra at £98, producing £294. The merged extra-body line is £196 for two bodies; the currency guard accepts £98 for one extra and rejects £196 or another booking's £160. Preview leaves the order unchanged.
- Native stock rejects four cameras when three are free. A probe initially expected success; its authoritative refusal is preserved in `/root/rental-marginal-fourth-body-block-proof.json`. The successful price test uses the available three-camera case.
- Commercial merge/captured-rate hazards use handler regression fixtures. The Native two-body probe already quoted £258 before the change; this scenario is not evidence of previous live overcharging. Its listing identity and receipt scope are verified separately.

Receipts: `/root/rental-offering-before-native-proof.json`, `/root/rental-offering-before-same-body-proof.json`, `/root/rental-offering-after-kit-proof.json`, `/root/rental-offering-after-same-body-proof.json`, `/root/rental-offering-after-two-body-proof.json`, `/root/rental-marginal-native-evidence-proof.json`, `/root/rental-marginal-full-tests.log`, `/root/rental-marginal-build.log`, `/root/rental-marginal-backend.log`. Exact production alias and fresh model results are separate release receipts.

## Scope and open audit

Real Hygglo chat migration, renter sends, financial execution and real cancellations/bookings remain blocked without explicit written consent. Simulation setup edits touched only their own `__probe__` Lab orders. All proposals were read-only.

Exact packing quantities/storage pools, explicit extra-kit selection, ambiguous removal across offerings, server-enforced quote-only mutation consent and confidence calibration remain audit targets. This phase does not prove overall production readiness.


## Shared receipt validator correction

The first fresh model extra-body run completed its quote tool call but failed when saving the draft: the backend's closed `draftEvidenceValidator` did not include `quote_role`. The shared validator now accepts the optional base/proposed_line/addition union, and a new contract test compares every emitted price-receipt field and role against the backend validator. Full revalidation: 1,129 passing tests, 14 skipped; Next build and Convex typecheck/deploy pass. The unavailable-lens fresh model reply passed, asked for the second body's camera/mount, and had no missing-price contract flag. Final extra-body model and exact deployment results remain in separate release receipts.
