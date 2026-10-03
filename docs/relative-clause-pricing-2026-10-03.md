# Price ownership in compatibility clauses

The native Lab model correctly quoted the Remus lens at £25/day (£50 for two days) and its required PL to L adapter at £10/day (£20 for two days), but the draft guard rejected the adapter daily rate. Its explicit-subject parser treated “pairs with ... which is” as a joint price subject, so it required evidence for an unpriced combined subject.

The parser now extracts the priced subject of compatibility relative clauses before checking item identity. It supports pairs, paired, works and used with, while preserving the actual sentence for date and duration validation. Unknown accessories, different mounts, multiple adapters, incorrect durations and incorrect amounts still fail.

Validation: 1,274 tests passed, 14 skipped across 100 files; Next production build and Convex typecheck/deploy passed. Graphify updated. A native model Lab run declined the unavailable Great Joy set and quoted the owned Remus plus required adapter at £70 additional / £194 total. It saved an approved draft and passed the send dry run. The original £124 booking remained unchanged and the fixture was cleaned up. Proof: /root/rental-relative-price-model-proof.json.

The broader production readiness audit remains open. Real Hygglo activation, messages and booking writes require separate explicit written consent. Owner access enforcement and durable phone push renewal remain unfinished.
