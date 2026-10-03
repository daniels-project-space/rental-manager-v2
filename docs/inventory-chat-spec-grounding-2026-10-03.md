# Inventory chat source consistency

The manager’s two chat surfaces share `dashboard-tools.ts`, which calls `walle_inventory:index` and `lookup`. This path still exposed generated item-spec descriptions as authoritative, joined them by display name, selected the first duplicate, and inferred lens autofocus from broad brand/mount names. The renter bot already required reviewed spec provenance, so the same item could produce different technical answers across surfaces.

Inventory chat now joins specs to the physical item ID and verifies the exact canonical identity through the shared reviewed-spec contract. Duplicate records require review. Unreviewed descriptions are withheld, and the response includes verification metadata or a verification-required flag. Focus classification uses reviewed lens prose; a brand, mount, manual iris or camera AF feature cannot establish lens autofocus. Manual override does not turn an autofocus lens into a manual-only lens.

Default inventory discovery requires active, positive owned stock and rejects marketing status independently of the marketing boolean. Explicit marketing lookup remains possible but labels those rows as unowned marketing. Both chat prompts now acknowledge unverified facts and stop treating a separately owned adapter as proof that it ships with a kit.

Validation: 22 focused tests covering provenance, identity joins, duplicates, focus and contradictory marketing flags, plus the existing closed chat tool schema, passed. The 15 schema tests passed after the final prompt edits. Convex typecheck/deploy and Graphify update passed. No paid model calls, full-suite rerun or local Next build were used.

Read-only deployed lookup verification retained reviewed Sony, Blackmagic and TTArtisan facts, withheld the generated Sony 28–70mm and 16–35mm descriptions, and retained the TTArtisan’s manual-focus classification. The current owned index contains 82 positive-stock items. The Arri lookup returned no rows with either marketing setting, so it does not establish a live marketing example; contradictory status/flag cases are covered by the focused tests. Receipt: `/root/rental-inventory-facts-native-proof.json`.

This fixes source selection, not every inventory specification. Unreviewed lens records still need exact-model confirmation and manufacturer review. Broader compatibility FAQ provenance, owner authentication cutover, multi-edit failures and physical phone acceptance remain open. Real Hygglo activation and writes remain gated by separate written consent.
