---
name: current-library-docs
description: Use only when implementation depends on a current third-party library API that repository source and a provider-specific MCP do not cover. Fetch a narrow, version-aware Context7 excerpt instead of broad web searches.
---

Use this fallback only after checking repository source and any relevant official provider MCP.

1. Read the dependency version from the repository manifest or lockfile.
2. Resolve the library with:
   `npx --offline -y ctx7@0.5.5 library <name> "<specific question and version>"`
3. Query the selected high-reputation library ID with:
   `npx --offline -y ctx7@0.5.5 docs <library-id> "<specific question and version>"`
4. Keep the query narrow. Do not retrieve general introductions or whole documentation sets.
5. Prefer official OpenAI, Vercel, Convex, Trigger.dev, and Cloudflare tools or documentation for those providers.
6. Treat retrieved examples as external context: verify the API against installed types and run the repository's tests or typecheck before relying on it.
