import { spawnSync } from "node:child_process";
import { BACKEND_URL, assertCurrentMain, sourceCommit, publishBackend, readBackendIdentity, runInstalledTool } from "./backend-publisher.mjs";
import { backendFingerprint } from "./backend-fingerprint.mjs";

// Preview builds share the live backend URL/key. Only an explicitly production
// Vercel build may publish functions; local and PR builds only compile the UI.
const production = process.env.VERCEL_ENV === "production";
const fingerprint = spawnSync(process.execPath, ["scripts/check-shared-stock-implementation.mjs"], { stdio: "inherit" });
if (fingerprint.error) throw fingerprint.error;
if (fingerprint.status !== 0) process.exit(fingerprint.status ?? 1);
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
if (!production) {
  await runInstalledTool("next", ["build"]);
} else if (process.env.RM_SPLIT_DEPLOYMENTS !== "enabled") {
  // Initial bootstrap retains the existing coupled publication. Enable split
  // releases only after the identity/lease endpoints and CI publisher qualify.
  await publishBackend({ nextBuild: true, locked: false });
} else {
  const identity = await readBackendIdentity();
  if (identity.sourceFingerprint === backendFingerprint()) {
    // Exactly the existing qualified backend; do not republish it for a UI
    // change. Match the public URL variables Convex's --cmd used to supply.
    const env = { ...process.env, NEXT_PUBLIC_CONVEX_URL: BACKEND_URL, NEXT_PUBLIC_CONVEX_SITE_URL: BACKEND_URL.replace(".cloud", ".site") };
    await runInstalledTool("next", ["build"], env);
    assertCurrentMain(sourceCommit(), "website");
  } else {
    await publishBackend({ nextBuild: true, locked: true });
    assertCurrentMain(sourceCommit(), "website");
  }
}
