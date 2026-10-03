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
