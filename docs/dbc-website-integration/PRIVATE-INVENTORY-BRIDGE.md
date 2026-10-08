# Private website stock reads

The registered POST /dbcinema/storefront-read route uses the existing DBCINEMA_WEBHOOK_SECRET and accepts only four read operations needed by DB Cinema's source sync. Account arguments must be exactly dbcinema. Authentication and argument checks precede dispatch; arbitrary functions, writes and additional account/limit/token arguments reject.

The actual public catalogue/master/reservation queries remain owner-protected. Typed internal counterparts are invoked only after service authentication. Projected responses omit renter identities and unrelated private metadata, hide internal exception details and use no-store. The website consumer validates the configured HTTPS Convex site, refuses redirects and verifies a protocol/path-bound receipt; no anonymous fallback remains.

Actual route/service tests exercise all four counterparts under enabled owner enforcement while direct public inventory rejects. Client fixtures and the paired native HTTP fixture exercise real website sync, source stock/cart occupancy, demand and invalid credentials. Fixtures use synthetic source records and isolated auth transport; they do not prove deployed owner or provider acceptance.

Publish this compatible manager endpoint first, correct existing synchronization credentials/target pairing and register the owner before enforcing owner auth, then publish and verify the website consumer. A frontend preview does not publish the backends. Canonical kit mapping, live freshness and a shared atomic reservation claim remain original requirements.

Validation: 139 test files / 2144 passing tests (14 existing skips), TypeScript, Next build, owner-boundary and HTTP-client audits pass. Both project graphs are updated. Hosted source-matched validation is pending. No production backend or gate changes were made.
