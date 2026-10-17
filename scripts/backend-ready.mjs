import path from "node:path";
import { backendFingerprint } from "./backend-fingerprint.mjs";
import { assertCurrentMain, readBackendIdentity, sourceCommit } from "./backend-publisher.mjs";
import { publishedInputsInclude } from "./deployment-impact.mjs";

/** A worker is admitted only after its compatible backend is actually served.
 * This reads a zero-database-I/O identity, never invokes a paid task/model. */
export async function waitForBackend({ read = readBackendIdentity, expected = backendFingerprint(), commit = sourceCommit(), current = assertCurrentMain, includes = publishedInputsInclude, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, timeoutMs = 10 * 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    current(commit, "trigger");
    const identity = await read();
    if (identity.sourceFingerprint === expected || identity.sourceCommit !== commit && includes(commit, identity.sourceCommit, "trigger")) return identity;
    await pause(3_000);
  }
  throw Error("Compatible production backend is not ready; no worker deployment started");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = await waitForBackend(); console.log(`Compatible production backend verified at ${result.sourceCommit}`);
}
