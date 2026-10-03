# Lens price resolution and protective packaging

Leo's Sony 16–35mm had mappings and real £20/day listings, but no qualified base listing reached the bot. The standalone offering (1115113) explicitly includes front/rear lens caps and a lens hood. The contents parser treated these untracked protective supplies as unresolved rental equipment, causing the shared base-listing validator to reject its lens price. A second offering (1172744) includes a tracked ND filter absent from its lens-only mapping; rejecting that mapping remains correct.

The shared contents parser now recognizes whole component labels for protective caps and lens hoods as supplied packaging. Mixed equipment lines stay unresolved. Filters, additional lenses and other tracked resources remain part of identity/stock validation. This repairs the underlying offering description interpretation used by listing resolution and Mastra pricing/recommendation tools, rather than adding a guessed price or bypassing mapping completeness. No marketplace listing, reservation or stock record is rewritten.

Validation: 39 focused contents/base-listing tests and project/backend typechecks. Deployed owned Lab acceptance verifies lookup and recommendation resolve the actual Leo lens listing price, preserve Native quote data through the SDK, reject the filter-incomplete offering, leave the booking unchanged and clean up the fixture. No paid generation is needed for this data-path fix.

Open work includes repairing incomplete tracked-component mappings, durable owner tasks for genuinely unpriced recommendations and broader production readiness. Real Hygglo messaging stays disabled.
