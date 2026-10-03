# Component identity: category headings, delimiters and packaging

A read-only listing/mapping comparison flagged camera flashes missing from action-camera kit mappings. The source was not a real flash: quantity-prefixed `Cameras:` headings were parsed as gear, and generic name matching confidently picked the inventory entry `Camera flash`. A separate FX3 listing counted `DJI RS3 Pro carry case` as another gimbal, making its valid stored mapping appear incomplete. Single explicit bullets also fell back to numeric splitting, which could break `DJI Osmo Action 5 Pro` at its model digit.

The shared name matcher now refuses confident identity for generic categories using its existing category detector. Contents extraction removes quantity-prefixed plural section labels, preserves the structure of a single bullet, and recognizes a model-specific carry case as packaging while preserving mixed gear lines. Repeated leading quantity markers remain explicitly unresolved rather than silently adopting the outer quantity.

This changes the shared data path used by listing completeness and pricing/stock tools, rather than adding per-item bot responses or automatically rewriting the 15 suspected mappings. `diag_price_coverage:componentMapping` provides bounded read-only diagnosis using actual stored listings, parser and physical coverage contract.

Validation: 92 focused parser/name/price/equivalence/resolution tests and project/backend typechecks. Deployed actual records show the FX3 kit complete with one camera, one lens and one gimbal; the malformed action-camera quantity stays incomplete without a phantom flash; the missing tracked ND filter remains an explicit coverage gap. An owned Lab booking verifies the real Mastra listing-context schema preserves the corrected physical inventory. No paid model call, real rental write or marketplace edit is needed.

Open: genuine mapping omissions still need source/ownership review and repair. Titles and descriptions sometimes conflict; some described products are marketing-only. No automatic bulk mapping write is justified by the diagnostic scan alone. Full production readiness remains unproven; real Hygglo messaging stays disabled.

## Reviewed ND-filter mapping repair

After validating the parser against live records, Leo listing 1172744 was repaired internally to include its explicitly supplied one ND filter. The transaction re-reads the live description, requires exactly the reviewed lens/filter identities and quantities, verifies both inventory items are active and owned, and requires the original mapping to contain only that lens. It refuses any changed contents or mapping and is idempotent after repair. Only the internal override is patched; marketplace descriptions, prices and reservation records are not rewritten. The filter remains an independently tracked stock resource. Native before/after and an owned Lab listing-context/SDK check verify the repaired physical component.

The other discrepancy candidates still require review, especially descriptions that contradict titles or describe marketing-only gear. This one repair does not prove the rest of the catalogue complete.
