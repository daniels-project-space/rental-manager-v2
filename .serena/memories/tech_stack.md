# Tech Stack

- TypeScript strict/noEmit, ES2022, bundler module resolution, @/* -> src/*.
- Next.js 16.2.4, React 19.2.4, Tailwind 4; Vercel frontend.
- Convex 1.37 for reactive data/functions; canonical live deployment must be verified from environment/provider state.
- Trigger.dev packages pinned 4.4.5; project id proj_cdhxwycwcjdmxnsodsmc; tasks loaded from src/trigger.
- Vitest 1.6.1; ESLint 9 with next/core-web-vitals + next/typescript.
- Mastra and Vercel AI SDK integrations; provider/model choices are routed in source/settings and must preserve quality/cost gates.
- npm scripts are canonical despite pnpm-workspace.yaml; package-lock.json is intentionally ignored.