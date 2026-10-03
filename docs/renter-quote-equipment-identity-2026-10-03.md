# Saved quotes retain physical equipment identity

The Native date and addition quote paths previously bound acceptance to dates, totals, listing IDs and quantities, while listing mappings could change their underlying physical inventory. An unchanged price and display name did not prove the quoted equipment was unchanged.

Both producers now attach an equipment identity key from the shared stock resolver: sorted Native inventory IDs, canonical names and aggregate tracked component quantities for the complete proposed basket. Native price evidence and approved owner-message metadata retain that key. Production acceptance compares the saved key with the current basket in the mutation snapshot before an unnamed acceptance can authorize an amendment. Legacy offers missing the key require a fresh quote. Explicit current named/date instructions still use their existing request and price checks. Stock is still rechecked before writes.

Validation: 170 focused tests passed, including unchanged acceptance and idempotency, changed physical pool with the same name and price, changed component quantity, missing legacy identity, evidence propagation and both owner-message archives. Project and Convex typechecks passed. Controlled deployed date and addition probes used actual Native quotes, actual price evidence builders, approved setDraft, recordSentReply, renter acceptance and actual Lab mutations; both applied exactly once and cleaned their own conversations. No model calls, catalogue mutations, real messages or real bookings.

Proofs: /root/rental-quote-identity-date-native-proof.json and /root/rental-quote-identity-addition-native-proof.json.

Limits: this binds quote acceptance, not every order from its initial creation. Only independently tracked physical stock components enter the fingerprint; standard accessories remain outside it. Send-time catalogue drift and general semantic quote completeness remain open audit work. Real Hygglo activation remains prohibited without Daniel’s separate explicit written consent.
