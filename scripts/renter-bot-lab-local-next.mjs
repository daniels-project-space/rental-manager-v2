import { spawnSync } from "node:child_process";
import { spawnRenterBotLabLocalChild, writeRenterBotLabLocalLog } from "./renter-bot-lab-local-process.mjs";

const envFile = process.env.RENTER_BOT_LAB_LOCAL_CONVEX_ENV_FILE;
const port = process.env.RENTER_BOT_LAB_LOCAL_NEXT_PORT ?? "3000";
if (!envFile || process.env.RENTER_BOT_LAB_DEPLOYMENT !== "local" || process.env.NODE_ENV !== "development") {
  throw new Error("Local Lab web startup requires the explicit probe-only development configuration.");
}

const run = (args, { allowFailure = false } = {}) => {
  const result = spawnSync("pnpm", args, { stdio: "ignore", env: process.env });
  if (result.error) {
    writeRenterBotLabLocalLog(`Local bootstrap process failed: ${result.error.message}`);
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return false;
    writeRenterBotLabLocalLog(`Local bootstrap command failed: pnpm ${args.join(" ")} (status ${result.status ?? "unknown"})`);
    process.exit(result.status ?? 1);
  }
  return true;
};
run(["exec", "convex", "env", "set", "--force", "--deployment", "local", "--from-file", envFile]);
run(["exec", "convex", "run", "renter_bot_lab_local_setup:bootstrapLocalLab", "{}"]);
const catalogReady = run(["exec", "convex", "run", "--deployment", "local",
  "renter_bot_lab_local_setup:refreshSourceCatalog", "{}"], { allowFailure: true });
if (!catalogReady) console.error("Lab catalogue refresh failed; the page will open with source-data readiness marked unavailable.");

writeRenterBotLabLocalLog(`Renter Bot Lab is local-only at http://127.0.0.1:${port}/renter-bot-lab`);
const next = spawnRenterBotLabLocalChild("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", port], {
  env: process.env,
});
process.once("SIGINT", () => next.kill("SIGINT"));
process.once("SIGTERM", () => next.kill("SIGTERM"));
next.once("close", (code, signal) => {
  writeRenterBotLabLocalLog(`Local Next server exited with code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`);
  process.exit(code ?? (signal ? 1 : 0));
});
next.once("error", (error) => {
  writeRenterBotLabLocalLog(`Could not start the isolated Lab web app: ${error.message}`);
  process.exitCode = 1;
});
