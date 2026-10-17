import { spawn } from "node:child_process";
import path from "node:path";
import { statSync } from "node:fs";

const BACKEND = "https://hearty-oyster-600.convex.cloud";
const VAULT = "https://fantastic-roadrunner-485.convex.cloud";
const BUCKET = "rental-manager-v2";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function query(url, body, authorization, { request, wait }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await request(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt === 2) throw Error("Backup credential transport unavailable after three bounded attempts");
      await wait(250 * (attempt + 1)); continue;
    }
    if (!response.ok) {
      if (attempt < 2 && (response.status >= 500 || response.status === 429)) { await wait(250 * (attempt + 1)); continue; }
      throw Error(`Backup credential query failed with HTTP ${response.status}`);
    }
    let result;
    try { result = await response.json(); }
    catch { throw Error("Backup credential response was not valid JSON"); }
    if (result.status !== "success") throw Error("Backup credential query was rejected");
    return result.value;
  }
}

/** Resolve the same current vault service used by the application. Secrets
 * remain in process memory and the uploader's environment, never logs/files. */
export async function loadBackupStorage({ deployKey = process.env.CONVEX_DEPLOY_KEY, request = fetch, wait = pause } = {}) {
  if (!deployKey?.trim()) throw Error("Private backup deployment credential is unavailable");
  const options = { request, wait };
  const variable = await query(`${BACKEND}/api/query`, {
    path: "_system/cli/queryEnvironmentVariables:get", args: [{ name: "VAULT_ACCESS_TOKEN" }], format: "convex_encoded_json",
  }, `Convex ${deployKey}`, options);
  if (typeof variable?.value !== "string" || !variable.value.trim()) throw Error("Application vault credential is unavailable");
  const rows = await query(`${VAULT}/api/query`, {
    path: "secrets:listByService", args: { service: "cloudflare", vaultToken: variable.value }, format: "json",
  }, undefined, options);
  if (!Array.isArray(rows)) throw Error("Application storage credential response is unavailable");
  const lookup = key => {
    const matches = rows.filter(row => row.keyName === key);
    if (matches.length > 1) throw Error("Ambiguous application storage configuration");
    const value = matches[0]?.value ?? "";
    if (typeof value !== "string" || /[\r\n]/.test(value)) throw Error("Invalid application storage configuration");
    return value;
  };
  if ((lookup("R2_BUCKET") || BUCKET) !== BUCKET) throw Error("Backup storage belongs to a different application");
  const account = lookup("R2_ACCOUNT_ID").toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(account)) throw Error("Invalid backup storage account");
  let endpoint;
  try { endpoint = new URL(lookup("R2_ENDPOINT") || `https://${account}.r2.cloudflarestorage.com`); }
  catch { throw Error("Invalid backup storage endpoint"); }
  const hostMatches = endpoint.hostname === `${account}.r2.cloudflarestorage.com` || endpoint.hostname.startsWith(`${account}.`) && endpoint.hostname.endsWith(".r2.cloudflarestorage.com");
  if (endpoint.protocol !== "https:" || !hostMatches || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" || endpoint.port) throw Error("Invalid backup storage endpoint");
  const accessKey = lookup("R2_ACCESS_KEY_ID"), secretKey = lookup("R2_SECRET_ACCESS_KEY");
  if (!accessKey.trim() || !secretKey.trim()) throw Error("Application storage credentials are unavailable");
  return { R2_ACCOUNT_ID: account, R2_ENDPOINT: endpoint.origin, R2_ACCESS_KEY_ID: accessKey, R2_SECRET_ACCESS_KEY: secretKey };
}

async function runUploader(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", () => reject(Error("Unable to start the backup uploader")));
    child.once("exit", code => code === 0 ? resolve() : reject(Error("Backup upload or verification failed")));
  });
}

export async function uploadBackup(localPath, key, { env = process.env, load = loadBackupStorage, run = runUploader } = {}) {
  if (!localPath || !/^backups\/rmv2\/\d{8}\/convex-hearty-oyster-600\.zip$/.test(key ?? "")) throw Error("Expected a local snapshot and the existing Rental Manager backup key");
  let snapshot;
  try { snapshot = statSync(localPath); } catch { throw Error("The exported backup snapshot is unavailable"); }
  if (!snapshot.isFile() || snapshot.size === 0) throw Error("The exported backup snapshot is empty or invalid");
  const storage = await load({ deployKey: env.CONVEX_DEPLOY_KEY });
  const childEnv = { ...env, ...storage };
  delete childEnv.CONVEX_DEPLOY_KEY;
  delete childEnv.VAULT_ACCESS_TOKEN;
  await run(process.execPath, [path.join(import.meta.dirname, "ci-r2-upload.mjs"), localPath, key], childEnv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try { await uploadBackup(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
