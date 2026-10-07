import { spawnSync } from "node:child_process";

// Preview builds share the live backend URL/key. Only an explicitly production
// Vercel build may publish functions; local and PR builds only compile the UI.
const production = process.env.VERCEL_ENV === "production";
const args = production
  ? ["convex", "deploy", "--check-build-environment=disable", "--cmd", "next build"]
  : ["next", "build"];
const result = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
