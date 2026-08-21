# Suggested Commands

- Install: `npm install`.
- Frontend dev: `npm run dev`.
- Convex dev/function push: `npm run dev:convex` or the exact verified live-target command from current env.
- Trigger local: `npm run trigger:dev`; deploy only with explicit deployment authorization: `npm run trigger:deploy`.
- Unit/integration tests: `npm test`; watch: `npm run test:watch`.
- Lint: `npm run lint`.
- Next production build: `npm run build:next`; full Convex + Next build: `npm run build`.
- Repository-specific guards: `npm run check:patterns`, `npm run check:mirror`, `npm run verify:trigger-key`.
- Refresh code graph after changes: `graphify update .`.