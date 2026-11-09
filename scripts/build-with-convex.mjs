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

if (production) {
  const labMode = process.env.RENTER_BOT_LAB_DEPLOYMENT;
  if (labMode !== "hosted") throw new Error("Production requires the isolated hosted Renter Bot Lab deployment.");
  if (process.env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false") {
    throw new Error("Production release blocked: real renter messaging must remain disabled for the Lab.");
  }

  const labUrlValue = process.env.RENTER_BOT_LAB_CONVEX_URL?.trim();
  const publicLabUrlValue = process.env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL?.trim();
  const labDeployKey = process.env.RENTER_BOT_LAB_CONVEX_DEPLOY_KEY?.trim();
  if (!labUrlValue || !publicLabUrlValue || !labDeployKey) {
    throw new Error("Production requires the isolated Lab URL and its private Convex deploy key.");
  }
  const labUrl = new URL(labUrlValue).origin;
  const publicLabUrl = new URL(publicLabUrlValue).origin;
  const mainUrl = new URL(BACKEND_URL).origin;
  if (labUrl !== publicLabUrl || labUrl === mainUrl) {
    throw new Error("Lab deployment target must match the Lab UI URL and remain separate from production Convex.");
  }
  if (new URL(labUrl).protocol !== "https:" || !new URL(labUrl).hostname.endsWith(".convex.cloud")) {
    throw new Error("The isolated Lab deployment URL is invalid.");
  }

  const labDeploymentName = new URL(labUrl).hostname.replace(/\.convex\.cloud$/, "");
  const labKeyScope = labDeployKey.split("|", 1)[0];
  if (labKeyScope !== `dev:${labDeploymentName}`) {
    throw new Error("The Lab deploy key must be scoped directly to the isolated Lab dev deployment.");
  }

  // Keep the Lab's functions and prepared-item facts in step with the page.
  // Let the deployment-scoped key select the backend. Passing --deployment
  // forces a management API lookup and bypasses the build's deploy-key auth.
  const labEnv = { ...process.env, CONVEX_DEPLOY_KEY: labDeployKey };
  delete labEnv.CONVEX_DEPLOYMENT;
  await runInstalledTool("convex", ["env", "set", "RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled"], labEnv);
  await runInstalledTool("convex", ["deploy", "--typecheck", "disable", "--codegen", "disable", "--message", `Renter Bot Lab ${sourceCommit()}`], labEnv);
}
