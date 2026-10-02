# Separate item quotes after a parenthesized daily rate

The Great Joy audit conversation was withheld for an adapter price of £20 even though its saved evidence contained a genuine Native two-day, one-unit PL-to-L quote for £20. The candidate said “the Blazar Remus 100mm is £50 (£25/day) and the PL to L mount adapter is £20 (£10/day).”

Price validation started the second clause immediately after the preceding currency amount. It consequently read `/day) and the adapter` as a combined-item subject and treated `day` as an unreceipted equipment item. Separating the adapter into another sentence passed with the same evidence, proving the clause-boundary cause.

The parser now removes only the preceding rate suffix or closing parenthesis followed by `and`/`plus` when determining the next amount's item subject. It preserves the original price, dates and quantity checks and does not turn separate receipts into a combined-kit price.

The exact saved candidate now has no unsupported-price claims. Tests also cover missing evidence, wrong amount, wrong duration, wrong quantity and a real lens-plus-adapter combined-price assertion. Full suite: 1,189 passed / 14 skipped across 91 files. Final build/backend/release and fresh conversation outcomes are recorded separately; the complete bot audit remains open and real Hygglo messaging stays disabled.
