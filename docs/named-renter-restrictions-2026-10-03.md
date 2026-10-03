# Native item restrictions at booking mutation boundaries

A controlled conflicting tool selection reproduced an unsafe edit: the latest renter message said not to add the Remus lens or PL to L adapter, but the complete-addition mutation accepted those items and changed the Lab booking from £124 to £194. The test deliberately supplied conflicting arguments; it did not claim the model chose them. The prior deny gate only recognised generic objects such as “anything”, “it” or “them”.

Named restrictions now resolve against Native inventory IDs, reviewed aliases and physical listing components before any addition or removal commits. The gate covers active negative instructions, common passive wording and leave-out/exclude/omit/hold-off instructions. Unknown restrictions require clarification. It distinguishes a prohibited adapter from an independently requested lens and preserves other named-item or action-specific restrictions. Both atomic additions and legacy item edits use the gate. Quote previews remain read-only.

Mapping checks reuse one inventory snapshot instead of reading the item collection again for each listing. Mapping prices and identity still use the actual account/listing rows.

Validation: 1,293 tests passed, 14 skipped across 100 files; Next build and Convex typecheck/deploy passed, owner source checks passed and Graphify updated. Seven native Lab cases passed: named and passive setup prohibitions, omitted adapter, legacy addition, protected camera removal, renter-supplied adapter with accepted lens at £174, and another camera restriction with accepted complete setup at £194. All fixtures cleaned. Baseline: /root/rental-named-negative-consent-baseline-proof.json. Validation: /root/rental-named-consent-native-proof.json. Actual model behavior will be checked after deployment.

This deny gate does not prove positive action/target agreement for every conversation or ambiguous pronoun acceptance. That remains part of the broader audit, along with owner authentication cutover and durable phone push renewal. Real Hygglo activation, messages and booking writes remain disabled pending separate explicit written consent.
