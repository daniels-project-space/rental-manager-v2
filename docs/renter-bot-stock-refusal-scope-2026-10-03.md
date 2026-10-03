# Exact stock evidence for group references and refusals

A fresh model used a valid joint Native basket check but its reply, “both the Blazar Remus 100mm anamorphic lens and the PL to L mount adapter are available together,” was rejected. The parser counted “both” as two lenses and did not resolve the trailing lens descriptor. Another reply used “which is available” after the adapter and lost the item reference. Separately, a replay showed that a negative Great Joy receipt could incorrectly qualify “I don't have that Sony FX3 to quote.”

The stock guard now resolves the coordinated group using exact Native lens and directional adapter identities. “Both” selects the named members; explicit per-member quantities still scale their physical components. Relative “which” refers only to an exact item named in the immediately preceding clause. Wrong focal lengths, adapter endpoints, dates, unknown members and separate stock successes remain insufficient.

Equipment refusals are parsed per subject and checked independently. An unrelated negative cannot support a refusal. Undated “don't have” requires an exact Native rental eligibility exclusion, rather than a calendar failure for gear the catalogue still offers. Native's `owned` field means active, non-marketing, positive-quantity rental eligibility; it is not a statement about legal ownership or whether inactive gear physically exists. That field now survives persistence and is recomputed at send time. Missing price, information, discounts and other services are not equipment refusals. Missing legacy stock evidence cannot silently qualify these claims.

Validation:

- 1,202 tests passed, 14 skipped, 91 files; six new regressions cover the actual coordinated reply, relative references, unrelated refusals, busy gear, Native exclusions and service language.
- Backend typecheck and Next production build passed.
- Saved actual model replies with their actual Native receipts replay through `/root/rental-stock-language-replay.mts`. Both positive lens/adapter false positives clear. The unresolved Great Joy set refusal remains blocked.
- The prior unrelated-negative bypass now produces a critical `UNGROUNDED_UNAVAILABILITY` flag (`/root/rental-stock-language-refusal-proof.json`).
- Graphify updated, retaining its known partial extraction warning for `audit_qty_drift_data.ts`.

Combined additional pricing and exact multi-focal set resolution remain open. This stock guard repair does not prove those conversations pass their complete price and factual validation. Real Hygglo messaging and booking activation remain disabled pending explicit written consent.
