# Shared specifications across unconfirmed model generations

A broad inventory name does not prove an exact Sony GM generation. Previously, handwritten descriptions asserted GM II for the 16–35mm and original GM for the 24–70mm. Neither was owner-confirmed or independently reviewed. The recommendation layer correctly refused them as capability evidence, but consequently returned no qualified 16mm autofocus option and asked the owner about all possible lenses.

`lens_variant_reviews` records independently reviewed capabilities and source URLs for every possible generation in a reviewed family. The shared capability reader computes the intersection. Differences, omitted properties, invalid sources, duplicate variants or stale reviews cannot borrow facts from a legacy profile. Returned capabilities explicitly declare `model_scope: shared_variants` and list the reviewed models. Exact generation remains unknown.

The two reviewed families supply shared autofocus, focal range, f/2.8 and full-frame coverage; the 16–35mm also has shared wide-angle classification. No generation-specific weight, dimensions, AF-motor claims, performance promises or kit contents are supplied. The 24–70mm wide-angle classification remains unreviewed. Manufacturer facts do not prove stock, account price or suitability for every shooting mode; those continue through existing Native checks.

Sony sources reviewed:
- https://www.sony.co.uk/electronics/camera-lenses/sel1635gm
- https://www.sony.com/electronics/support/lenses-e-mount-lenses/sel1635gm/specifications
- https://www.sony.co.uk/lenses/products/sel1635gm2
- https://www.sony.co.uk/lenses/products/sel1635gm2/spec
- https://www.sony.co.uk/electronics/camera-lenses/sel2470gm
- https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/sel2470gm/specifications
- https://www.sony.co.uk/lenses/products/sel2470gm2
- https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/sel2470gm2/specifications

Validation: 15 focused lens/spec tests and project/backend typechecks. Native before/after recommendation evidence and a fresh model Lab run are recorded separately under `/root/rental-shared-lens-*`. Only internal catalogue reviews and owned Lab fixtures are written. Real Hygglo messaging remains disabled. Full production readiness remains unproven.

## Fresh model finding and identity correction

The actual Gemini 3.7 Flash Lab reply correctly described the manual TTArtisan lens, offered the reviewed Sony 16–35mm with a matching Native stock result, left the booking untouched and declined to invent its price. It was blocked by the stock guard: lookup matching normalized `f/2.8` to `f2.8`, but exact mention/relative-clause stock identity did not. The guard could not resolve the preceding lens in “Sony GM 16–35mm f/2.8, which is available”.

A shared `normalizeApertureNotation` now serves both lookup tokenization and stock identity. It changes spelling only, preserving aperture value and F/T unit. No fuzzy matching or receipt bypass is introduced. Ninety-one focused stock/name tests pass, including changed lens, aperture, generation, date and unavailable/no-receipt cases. The failed paid call cost $0.011180325; its output and evidence are retained in `/root/rental-shared-lens-model-proof.json`. Verification of the correction reuses that actual output rather than paying for a duplicate model call.

Open issue: the Leo 16–35mm recommendation reports no usable account quote despite physical item overrides. No guessed price or marketplace edit has been introduced. Owner pricing workflow also needs review; a prose promise to check with the team is not durable task evidence.
