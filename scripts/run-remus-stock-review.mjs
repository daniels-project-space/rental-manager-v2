import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKEND_URL, readBackendIdentity } from "./backend-publisher.mjs";
import { installedToolEntry } from "./installed-tool.mjs";

const FUNCTION_PATH = "seed/remus_stock_review:apply";
const REMUS_STOCK_SOURCE = "Owned Remus master-stock reconciliation, 28 October 2026";
const REVIEWED_OFFERS = 22;
const MAX_MASTER_ITEM_WRITES = 5;
const MAX_PRODUCT_WRITES = REVIEWED_OFFERS;
const execFileAsync = promisify(execFile);

export function convexRunArguments(dryRun) {
  return ["run", FUNCTION_PATH, JSON.stringify({ dryRun }), "--typecheck", "disable", "--codegen", "disable"];
}

export function parseConvexRunOutput(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Convex CLI returned no Remus stock review summary.");
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Convex CLI returned an invalid Remus stock review summary.");
  }
}

async function executeConvexRun({ dryRun, key }) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [installedToolEntry("convex"), ...convexRunArguments(dryRun)], {
      env: { ...process.env, CONVEX_DEPLOY_KEY: key },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return parseConvexRunOutput(stdout);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Convex CLI returned")) throw error;
    const raw = [error?.stderr, error?.message].filter(value => typeof value === "string").join("\n");
    const safe = raw.replaceAll(key, "[redacted]")
      .replace(/(?:prod|dev|preview):[A-Za-z0-9-]+\|[^\s]+/g, "[deploy key]")
      .replace(/(?:Convex|Bearer)\s+[^\s]+/gi, "[authorization redacted]")
      .replace(/\x1b\[[0-9;]*m/g, "");
    const detail = safe.split(/\r?\n/).map(line => line.trim())
      .filter(line => line && /error|failed|unauthorized|forbidden|not found|cannot|could not|expected|deployment/i.test(line))
      .slice(-2).join(" ").slice(0, 300);
    throw new Error("Convex CLI could not complete the Remus stock review." + (detail ? " " + detail : ""));
  }
}

/** @param {{ dryRun?: boolean, key?: string, execute?: typeof executeConvexRun }} options */
export async function runRemusStockReview({ dryRun, key = process.env.CONVEX_DEPLOY_KEY, execute = executeConvexRun } = {}) {
  if (typeof dryRun !== "boolean") throw new Error("A dry-run flag is required.");
  if (!key?.trim()) throw new Error("The protected production credential is unavailable.");
  return execute({ dryRun, key });
}

function validatePlan(value, dryRun) {
  if (value?.dryRun !== dryRun || value?.source !== REMUS_STOCK_SOURCE || value?.reviewedOffers !== REVIEWED_OFFERS ||
      !Number.isSafeInteger(value?.itemWrites) || value.itemWrites < 0 || value.itemWrites > MAX_MASTER_ITEM_WRITES ||
      !Number.isSafeInteger(value?.productWrites) || value.productWrites < 0 || value.productWrites > MAX_PRODUCT_WRITES ||
      value?.rentalChanges !== 0 || value?.messagesSent !== 0) {
    throw new Error("Stock review did not match the reviewed 22-offer Remus repair plan.");
  }
  return value;
}

export async function reconcileRemusStockReview({ apply = false, verifyIdentity = readBackendIdentity, run = runRemusStockReview } = {}) {
  if (typeof apply !== "boolean") throw new Error("An explicit apply flag is required.");
  await verifyIdentity();
  const before = validatePlan(await run({ dryRun: true }), true);
  if (before.itemWrites === 0 && before.productWrites === 0) return { mode: "already-in-sync", before };
  if (!apply) return { mode: "dry-run", before };

  const applied = validatePlan(await run({ dryRun: false }), false);
  if (applied.itemWrites !== before.itemWrites || applied.productWrites !== before.productWrites) {
    throw new Error("Apply did not match the reviewed Remus stock repair plan.");
  }
  const after = validatePlan(await run({ dryRun: true }), true);
  if (after.itemWrites !== 0 || after.productWrites !== 0) throw new Error("Post-apply Remus review is not clean.");
  return { mode: "applied-and-verified", before, applied, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.env.APPLY === "true";
  reconcileRemusStockReview({ apply })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "The Remus stock review failed.");
      process.exitCode = 1;
    });
}
