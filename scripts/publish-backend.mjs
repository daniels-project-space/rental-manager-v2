import { publishBackend, readBackendIdentity, sourceCommit, assertCurrentMain } from "./backend-publisher.mjs";
import { backendFingerprint } from "./backend-fingerprint.mjs";

if (process.env.RM_SPLIT_DEPLOYMENTS !== "enabled" || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main") {
  throw Error("Independent backend publication requires the enabled protected-main workflow");
}
const head = sourceCommit();
try {
  assertCurrentMain(head);
  const identity = await readBackendIdentity();
  const expected = backendFingerprint();
  if (identity.sourceFingerprint === expected) console.log("Qualified backend source is already published; nothing republished.");
  else console.log(`Published backend source ${await publishBackend()}`);
} catch (error) {
  if (error.message.includes("inputs are superseded")) console.log("Backend release superseded by newer backend inputs; nothing published.");
  else throw error;
}
