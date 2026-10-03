# Amendment monetary claims

Correct extension offers containing both the additional charge and final booking total could be refused: “£46 extra, bringing the total to £170” allowed the first amount’s label to spill into the second. Removal consent also accepted a matching number with the wrong financial role, such as the reduction labelled as the remaining total.

Addition, date and removal consent now share currency parsing that bounds each claim by neighbouring amounts and assigns its financial role. Explicit base, total, increase, reduction and daily claims must match the appropriate Native evidence. Unsupported currencies, malformed precision and unrelated financial purposes refuse consent. Common GBP notation is supported. Unlabelled removal amounts retain compatibility with the actual reduction or remaining total.

The reply price guard carries an extension’s explicit period through its marginal-charge and final-total clauses within the same conditional sentence. It still checks Native whole-basket pricing and rejects inconsistent dates, duration or totals. An anchored final-total explanation can accompany a direct named addition request.

Validation: 376 focused tests across seven files passed; the final currency parser adjustment passed the 101 consent tests. Convex typecheck/deployment and Graphify update passed. No full-suite rerun, local Next build or paid model call was needed for this backend change.

A deployed Native test booking quoted the complete extension at £170 with £46 additional cost, passed the ordinary reply guard, archived the synthetic owner offer and accepted a natural yes exactly once. It then accepted a named addition, refused removal claims with swapped reduction/total roles and an explicit USD price without changing the booking, and accepted the correct GBP reduction/remaining-total instruction exactly once. The fixture was cleaned. This verifies actual deployed queries/mutations with a synthetic offer, not model tool selection or real rental writes. Receipt: `/root/rental-money-scope-native-proof.json`.

This is one phase of the continuing audit. Multi-edit behavior, owner authentication cutover, physical phone delivery acceptance and broader inventory/metrics review remain open. Real Hygglo activation, messaging and booking writes require separate explicit written consent.
