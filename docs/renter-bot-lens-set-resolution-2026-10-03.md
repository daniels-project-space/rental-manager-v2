# Explicit lens-set lookup and missing-information review

The Lab conversation requested Great Joy 35mm, 50mm and 85mm together. Treating that description as one inventory item produced unknown stock, although Native inventory contains three separate exact identities. `check_availability` now resolves an explicit prime family/focal list and returns `resolved_items` for `check_basket_availability`. Resolution is not a stock receipt: the first result remains unknown, and a confirmed booking still requires the joint tool's addition/replacement context.

The resolver preserves mount/aperture variant tokens, includes marketing entries when detecting ambiguity, and refuses missing/duplicate/ambiguous members. It does not select a rentable variant to hide an ambiguous identity. This deliberately narrow parser does not infer unspecified sets or quantities from fuzzy names.

A fresh model conversation also exposed a false refusal flag for “I don't have verified pricing or availability to quote”. The shared refusal classifier now recognizes qualified information/pricing objects. Separate equipment refusals still require exact Native evidence.

Validation: five identity regressions, an additional refusal boundary regression, full suite, Next production build and Convex typecheck. Native read-only resolution returned all three exact Great Joy identities; the subsequent joint check returned `not_rentable`/`owned:false` for all three. The unverified 100mm member stayed unknown. Replaying the actual rejected candidate with its captured Native evidence now yields no guard flags. The Lab probe left the £124 order unchanged and was cleaned up.

This is partial lens-set repair, not proof of end-to-end conversation readiness. The fresh conversation before the final description/classifier deployment did not yet check the exact requested set before suggesting alternatives. The full grouped refusal grammar and positive set promises remain audit work. Live Hygglo sends and booking changes remain disabled.
