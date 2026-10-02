# Renter booking restrictions — 2 October 2026

The Lab booking mutation now reads the current server-side renter message before changing stock, dates or the order. Explicit quote-only and no-change language blocks writes even if a model requests an edit. Read-only addition previews remain available. Ordinary price questions also block edits unless the message separately requests one.

This is a deny gate for common restrictions, not full semantic consent or item/quantity reconciliation. Targeted negations, conditionals and selection between multiple commercial offerings remain audit work. Real Hygglo generation and sending remain disabled pending explicit written authorization.

Validation: 1,134 tests passed, 14 skipped; Next build and Convex typecheck/deployment passed. Graphify was updated (existing partial AST warning for audit_qty_drift_data.ts remains). An owned Native Lab session proved all three edit types were rejected without changing the order; an addition preview quoted £98 without writing; subsequent explicit confirmation added one FX3, resulting in £196, and replay made no additional edit. The owned test session was removed. Evidence: /root/rental-consent-native-live-proof.json.
