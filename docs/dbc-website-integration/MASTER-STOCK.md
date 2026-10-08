# Website master quantity contract

items:listForReconcile now includes the current master status and is_marketing_only values alongside existing identities, names, aliases and quantities. This lets the paired website distinguish actual owned active stock from inactive, marketing-only or incomplete records without guessing.

The actual handler projection test exercises positive/zero/inactive/marketing quantities, preserves compatibility fields and excludes unrelated private metadata. A second test verifies that enabled owner enforcement denies unauthenticated access before inventory reads.

The website's matching source removes historical quantity maxima and kit-demand inflation, preserves real rental occupancy and uses a new sync fingerprint. Old source eligibility is treated as unknown and supplies zero. Publish this compatible export before its website consumer. The website currently reads this query anonymously; a credentialed bridge is still required for enabled owner enforcement. No owner gate was relaxed and no live backend was published for this change.

Complete canonical kit identity and a single atomic inventory claim across website and Hygglo writers remain original goal requirements. The export and exact mirrored counts alone do not prove live availability or distributed no-double-booking.
