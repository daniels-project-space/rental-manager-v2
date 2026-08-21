# Task Completion

- Run focused Vitest suites covering changed logic with realistic fixtures and boundary/transition cases.
- Run `npm test`, `npm run lint`, `npm run check:patterns`, and `npm run build:next`; run mirror checks when shared/runtime contracts change.
- Inspect TypeScript/Serena diagnostics for edited files.
- For UI changes, validate rendered desktop + narrow mobile behavior and inspect screenshots.
- For Convex/Trigger changes, validate against real-shaped or approved live rental data without sending renter messages or mutating consequential production state.
- Run `graphify update .` after code changes.
- A local green build is insufficient for deployment work: verify exact Convex target, Trigger release, Vercel deployment SHA/status, and production alias.