# Original Remus model specification corrections

Four owned PL Remus records contained unsupported handwritten specifications. The 33/45/65mm entries all claimed T1.6, and the records also had incorrect close-focus distances, weights, coverage and iris counts. All four asserted amber flare without establishing the supplied variant.

The reviewed original-series model facts come from [Blazar’s Remus table](https://blazarlens.com/remus/). The inventory migration requires a unique exact owned active PL lens identity and a unique spec record. It stores manufacturer provenance, replaces the old prose and leaves quantities, rental contents, mounts, prices and bookings unchanged. Reapplying identical facts does not rewrite the record.

| Model | Aperture | Close focus | PL weight |
| --- | --- | --- | --- |
| 33mm | T1.8 | 0.49m | 880g |
| 45mm | T2.0 | 0.68m | 720g |
| 65mm | T2.0 | 0.69m | 782g |
| 100mm | T2.8 | 0.71m | 788g |

The descriptions distinguish original Remus from Remus II and Remus-M. They do not establish the supplied flare or guarantee compatibility with an arbitrary adapter.

Convex typecheck/deployment and Graphify update passed. The actual deployed migration and manager lookup verified all four records. An isolated deployed Native 100mm test booking confirmed that the renter bot’s listing-context tool receives the reviewed text and source metadata; the fixture was cleaned. Receipt: `/root/rental-remus-native-proof.json`. No paid model call, full-suite rerun, local Next build or tests that merely duplicate the static table were needed.

The full audit remains active. Pending Sony GM generation confirmation, remaining lens/spec provenance, adapter compatibility and recommendation behavior still need review. Real Hygglo activation, messaging and booking writes remain gated by separate written consent.
