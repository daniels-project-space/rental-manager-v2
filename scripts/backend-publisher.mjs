import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeBackendFingerprint } from "./backend-fingerprint.mjs";
import { backendFingerprint } from "./backend-fingerprint.mjs";
import { assertCurrentInputs } from "./deployment-impact.mjs";
import { withConvexTemp } from "./convex-temp.mjs";
import { installedToolEntry, nextBuildCommand } from "./installed-tool.mjs";

export const BACKEND_URL = "https://hearty-oyster-600.convex.cloud";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function sourceCommit() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("Invalid source commit");
  return sha;
}
export function assertCurrentMain(sha, layer = "backend") {
  assertCurrentInputs(sha, layer);
}
export async function backendRpc(kind, name, args = {}, { env = process.env, request = fetch, pause = sleep } = {}) {
  const key = env.CONVEX_DEPLOY_KEY;
  if (!key?.trim()) throw Error("Private Convex deployment credential is unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await request(`${BACKEND_URL}/api/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Convex ${key}` },
        body: JSON.stringify({ path: `deployment_identity:${name}`, args: [args], format: "convex_encoded_json" }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === 2) throw Error("Backend deployment transport unavailable after three bounded attempts");
      await pause(250 * (attempt + 1)); continue;
    }
    if (!response.ok) {
      if (attempt < 2 && (response.status >= 500 || response.status === 429)) { await pause(250 * (attempt + 1)); continue; }
      throw Error(`Backend deployment ${kind} failed with HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.status !== "success") throw Error(`Backend deployment ${name} failed`);
    return result.value;
  }
}
export async function readBackendIdentity() {
  const result = await backendRpc("query", "current");
  if (result.deploymentUrl !== BACKEND_URL) throw Error("Production backend identity does not match Rental Manager");
  return result;
}
export async function runCommand(command, args, env = process.env, signal) {
  if (signal?.aborted) throw Error("Backend publication was stopped before starting a command");
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, { stdio: "inherit", env, detached: grouped });
  let stopping;
  const terminate = () => {
    if (stopping) return;
    stopping = (async () => {
      const kill = name => {
        try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      kill("SIGTERM");
      // pnpm/Next/Convex may spawn descendants. Stop the whole group before
      // releasing the lease, including descendants surviving their parent.
      await sleep(250);
      kill("SIGKILL");
    })();
  };
  signal?.addEventListener("abort", terminate, { once: true });
  return await new Promise((resolve, reject) => {
    const finish = async (code, killedBy, error) => {
      signal?.removeEventListener("abort", terminate);
      try {
        if (stopping) await stopping;
        if (error) throw error;
        if (code !== 0 || signal?.aborted) throw Error(`Deployment command failed (${killedBy || code})`);
        resolve();
      } catch (failure) { reject(failure); }
    };
    child.once("error", error => { void finish(null, null, error); });
    child.once("exit", (code, killedBy) => { void finish(code, killedBy); });
  });
}

export function runInstalledTool(name, args, env = process.env, signal) {
  return runCommand(process.execPath, [installedToolEntry(name), ...args], env, signal);
}

/** Hold one bounded lease and stop the child promptly if ownership cannot be
 * renewed. Release only our own lease, including command/verification errors. */
export async function withBackendLease(work, { rpc = backendRpc, currentMain = assertCurrentMain, commit = sourceCommit(), pause = sleep, heartbeatMs = 20_000 } = {}) {
  const owner = `publisher:${randomUUID()}`;
  const args = { owner, sourceCommit: commit };
  const deadline = Date.now() + 12 * 60_000;
  let acquired = false;
  while (Date.now() < deadline) {
    currentMain(commit);
    const result = await rpc("mutation", "acquire", args);
    if (result.acquired) { acquired = true; break; }
    await pause(3_000);
  }
  if (!acquired) throw Error("Another backend publisher still owns the deployment lease");
  const abort = new AbortController();
  let finished = false, heartbeatError, stopHeartbeat = () => {};
  const heartbeat = (async () => {
    while (!finished) {
      const tick = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(true), heartbeatMs);
        stopHeartbeat = () => { clearTimeout(timer); resolve(false); };
      });
      if (!tick || finished) break;
      try {
        const result = await rpc("mutation", "renew", args);
        if (!result.renewed) throw Error("Backend deployment lease ownership was lost");
      } catch (error) { heartbeatError = error; abort.abort(); break; }
    }
  })();
  try {
    currentMain(commit);
    const result = await work(abort.signal);
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    finished = true;
    stopHeartbeat();
    try { await rpc("mutation", "release", args); }
    finally { await heartbeat; }
  }
}

export async function publishBackend({ nextBuild = false, locked = true } = {}) {
  let fingerprint;
  const deploy = async signal => {
    if (locked) {
      const current = await readBackendIdentity();
      const expected = backendFingerprint();
      if (current.sourceFingerprint === expected) {
        fingerprint = expected;
        if (nextBuild) {
          const env = { ...process.env, NEXT_PUBLIC_CONVEX_URL: BACKEND_URL, NEXT_PUBLIC_CONVEX_SITE_URL: BACKEND_URL.replace(".cloud", ".site") };
          await runInstalledTool("next", ["build"], env, signal);
        }
        return;
      }
    }
    await withConvexTemp(async env => {
      // Prepare bindings before fingerprinting. The actual deploy below still
      // performs its normal full backend typecheck before publication.
      await runInstalledTool("convex", ["codegen", "--typecheck=disable"], env, signal);
      await runCommand(process.execPath, ["scripts/check-shared-stock-implementation.mjs"], env, signal);
      fingerprint = writeBackendFingerprint();
      const args = ["deploy", "--check-build-environment=disable"];
      if (nextBuild) args.push("--cmd", nextBuildCommand());
      await runInstalledTool("convex", args, env, signal);
      const identity = await readBackendIdentity();
      if (identity.sourceFingerprint !== fingerprint) throw Error("Published backend does not match the qualified source");
      await runInstalledTool("convex", ["run", "stock_input_cache_admin:ensureSharedSnapshot", JSON.stringify({ expectedDeploymentUrl: BACKEND_URL })], env, signal);
    });
  };
  if (locked) await withBackendLease(deploy);
  else await deploy(); // Bootstrap only; split mode remains disabled until qualified.
  return fingerprint;
}
