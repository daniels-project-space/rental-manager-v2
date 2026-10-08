# Website master quantity contract

items:listForReconcile now includes the current master status and is_marketing_only values alongside existing identities, names, aliases and quantities. This lets the paired website distinguish actual owned active stock from inactive, marketing-only or incomplete records without guessing.

The actual handler projection test exercises positive/zero/inactive/marketing quantities, preserves compatibility fields and excludes unrelated private metadata. A second test verifies that enabled owner enforcement denies unauthenticated access before inventory reads.

The website's matching source removes historical quantity maxima and kit-demand inflation, preserves real rental occupancy and uses a new sync fingerprint. Old source eligibility is treated as unknown and supplies zero. Publish this compatible export before its website consumer. The paired private inventory bridge now implements authenticated source reads under owner enforcement and must be published/verified with this export. No owner gate was relaxed and no live backend was published for this change.

Complete canonical kit identity and a single atomic inventory claim across website and Hygglo writers remain original goal requirements. The export and exact mirrored counts alone do not prove live availability or distributed no-double-booking.

Validation: 138 default test files / 2131 passing tests (14 existing skips), TypeScript, Next production build and both owner audits pass locally. Hosted CI 37726916354 for 8d19ed4 is terminal SUCCESS; matching preview dpl_ACRaS9DHXKdKYpKj9zA1fPmj4S2N is READY. Website source 3ae28d2 passes hosted CI 37726913850 including full native checkout regression and has a READY matching preview. No paired backend publication has occurred.
