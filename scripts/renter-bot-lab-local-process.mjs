import { closeSync, chmodSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_LOG_BYTES = 1024 * 1024;

export function writeRenterBotLabLocalLog(message) {
  const directory = join(process.cwd(), ".next", "dev", "logs");
  const path = join(directory, "renter-bot-lab-local.log");
  let descriptor;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const line = Buffer.from(`[${new Date().toISOString()}] ${String(message).replace(/\s+/g, " ")}\n`);
    const size = (() => {
      try { return statSync(path).size; } catch { return 0; }
    })();
    descriptor = openSync(path, size + line.length > MAX_LOG_BYTES ? "w" : "a", 0o600);
    chmodSync(path, 0o600);
    writeSync(descriptor, line.subarray(0, MAX_LOG_BYTES));
  } catch {
    // Logging must never take down the isolated Lab supervisor.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

/** Long-lived local services must not inherit a PTY or a transient command pipe. */
export function spawnRenterBotLabLocalChild(command, args, options = {}) {
  return spawn(command, args, { ...options, stdio: "ignore" });
}
