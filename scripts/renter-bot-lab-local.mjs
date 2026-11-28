import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchRenterBotLabBackendRevision } from "../src/lib/renter-bot-lab-backend-revision.mjs";
import { spawnRenterBotLabLocalChild, writeRenterBotLabLocalLog } from "./renter-bot-lab-local-process.mjs";

const root = process.cwd();
const envPath = join(root, ".env.local");
const original = readFileSync(envPath, "utf8");
const current = {};
for (const line of original.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match) continue;
  let value = match[2];
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  current[match[1]] = value;
}
for (const key of ["CONVEX_DEPLOYMENT", "NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL", "RENTER_BOT_LAB_API_SECRET"]) {
  if (!process.env[key] && current[key]) process.env[key] = current[key];
}
if (!process.env.OPENROUTER_API_KEY?.trim() && !process.env.VAULT_ACCESS_TOKEN?.trim()) {
  throw new Error("No model credential in this process. Run with the OpenRouter key from the authorized vault, or configure VAULT_ACCESS_TOKEN locally.");
}
if (!process.env.CONVEX_DEPLOYMENT?.startsWith("local:")) {
  throw new Error("This command requires the project's local Convex deployment in .env.local; it will not select or configure a hosted deployment.");
}

const labUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
if (!labUrl || !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(labUrl)) {
  throw new Error("The local Lab needs NEXT_PUBLIC_CONVEX_URL to point to a loopback Convex deployment.");
}
const port = Number(process.env.RENTER_BOT_LAB_LOCAL_NEXT_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local Lab web port");
const apiBase = "http://127.0.0.1:" + port;
const secret = current.RENTER_BOT_LAB_API_SECRET || randomBytes(32).toString("base64url");
const authMarker = "lab-auth-v1:" + createHash("sha256").update(secret).digest("hex");
const localValues = {
  RENTER_BOT_LAB_DEPLOYMENT: "local",
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "false",
  RENTER_BOT_LAB_CONVEX_URL: labUrl,
  NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: labUrl,
  RENTER_BOT_LAB_API_BASE_URL: apiBase,
  RENTER_BOT_LAB_API_SECRET: secret,
  RENTER_BOT_LAB_SCENARIO_SEEDING: "enabled",
  RENTER_BOT_LAB_AUTH_CONFIG_VERSION: authMarker,
};

const lines = original.split(/\r?\n/);
for (let index = lines.length - 1; index >= 0; index--) {
  if (/^\s*(RENTER_BOT_LAB_SOURCE_REVISION|RENTER_BOT_LAB_API_SOURCE_FINGERPRINT)\s*=/.test(lines[index])) lines.splice(index, 1);
}
for (const [key, value] of Object.entries(localValues)) {
  const index = lines.findIndex((line) => new RegExp("^\\s*" + key + "\\s*=").test(line));
  const line = key + "=" + JSON.stringify(value);
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  process.env[key] = value;
}
// Fingerprints are computed from the source tree on each readiness request;
// discard stale manual pins that could hide edits made during a local session.
delete process.env.RENTER_BOT_LAB_SOURCE_REVISION;
delete process.env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT;
writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
chmodSync(envPath, 0o600);

await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve(true)));
});

const tempDir = mkdtempSync(join(tmpdir(), "renter-bot-lab-local-"));
const convexEnvFile = join(tempDir, "convex.env");
const convexValues = {
  RENTER_BOT_LAB_DEPLOYMENT: localValues.RENTER_BOT_LAB_DEPLOYMENT,
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: localValues.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED,
  RENTER_BOT_LAB_API_BASE_URL: apiBase,
  RENTER_BOT_LAB_API_SECRET: secret,
  RENTER_BOT_LAB_SCENARIO_SEEDING: localValues.RENTER_BOT_LAB_SCENARIO_SEEDING,
  RENTER_BOT_LAB_AUTH_CONFIG_VERSION: authMarker,
};
writeFileSync(convexEnvFile, Object.entries(convexValues).map(([key, value]) => key + "=" + JSON.stringify(value)).join("\n"), { mode: 0o600 });
process.env.RENTER_BOT_LAB_LOCAL_CONVEX_ENV_FILE = convexEnvFile;
process.env.RENTER_BOT_LAB_LOCAL_NEXT_PORT = String(port);

const stopBackendRevisionWatch = watchRenterBotLabBackendRevision(root, (revision, error) => {
  if (revision) writeRenterBotLabLocalLog(`Convex source revision updated: ${revision.slice(0, 16)}; waiting for Convex to reload.`);
  else writeRenterBotLabLocalLog(`Could not refresh the Convex source revision: ${error?.message ?? "unknown error"}`);
});

writeRenterBotLabLocalLog(`Starting local-only Lab at ${apiBase}/renter-bot-lab`);
const child = spawnRenterBotLabLocalChild("pnpm", ["exec", "convex", "dev", "--start", "node scripts/renter-bot-lab-local-next.mjs"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "development" },
});
const cleanup = () => {
  stopBackendRevisionWatch();
  rmSync(tempDir, { recursive: true, force: true });
};
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("close", (code, signal) => {
  cleanup();
  writeRenterBotLabLocalLog(`Local Lab supervisor exited with code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
child.once("error", (error) => {
  writeRenterBotLabLocalLog(`Could not start the isolated local Lab processes: ${error.message}`);
  process.exitCode = 1;
});
