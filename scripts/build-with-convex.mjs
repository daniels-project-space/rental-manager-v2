import { spawnSync } from "node:child_process";

// Preview builds share the live backend URL/key. Only an explicitly production
// Vercel build may publish functions; local and PR builds only compile the UI.
const production = process.env.VERCEL_ENV === "production";
if (production) {
  const expectedDbcUrl = "https://zany-wolf-18.convex.cloud";
  const configuredDbcUrl = process.env.DBCINEMA_CONVEX_URL;
  if (configuredDbcUrl !== expectedDbcUrl) {
    throw new Error("Production requires DBCINEMA_CONVEX_URL to target the DB Cinema production deployment.");
  }
  if (!process.env.DBCINEMA_ADMIN_TOKEN?.trim()) {
    throw new Error("Production requires DBCINEMA_ADMIN_TOKEN for the DB Cinema chat bridge.");
  }
}
const args = production
  ? ["convex", "deploy", "--check-build-environment=disable", "--cmd", "next build"]
  : ["next", "build"];
const result = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
