import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKEND_URL, readBackendIdentity } from "./backend-publisher.mjs";
import { installedToolEntry } from "./installed-tool.mjs";

const FUNCTION_PATH = "seed/dji_mic1_stock_review:apply";
const MIC1_DIAGNOSTIC_QUERY = `const account = "dbcinema";
const productId = 852812;
const product = await ctx.db.query("hygglo_products").withIndex("by_account_product", q => q.eq("accountSlug", account).eq("productId", productId)).first();
if (!product) return { productFound: false };
const linkedMaster = product.masterItemId ? await ctx.db.get(product.masterItemId) : null;
const mappings = await ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", account).eq("product_id", productId)).take(2);
const mic1 = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "DJI Wireless Mics")).take(2);
const mic2 = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "DJI Mic 2 wireless")).take(2);
const mappingDetails = await Promise.all(mappings.map(async row => ({
  source: row.source,
  components: await Promise.all(row.components.map(async component => {
    const item = await ctx.db.get(component.item_id);
    return { name: item?.name_canonical ?? "missing", quantity: component.qty };
  })),
})));
return {
  productFound: true,
  productMaster: { name: linkedMaster?.name_canonical ?? "missing", quantity: linkedMaster?.qty ?? null, unitKind: linkedMaster?.unit_kind ?? null },
  mic1: mic1.map(item => ({ name: item.name_canonical, quantity: item.qty, unitKind: item.unit_kind, status: item.status, contents: item.compatibility?.included_with_rental ?? [] })),
  mic2: mic2.map(item => ({ name: item.name_canonical, quantity: item.qty, unitKind: item.unit_kind, status: item.status })),
  mappings: mappingDetails,
};`;
const EXPECTED = {
  reviewedOffers: 1,
  itemWrites: 1,
  productWrites: 1,
  mappingWrites: 1,
  ownedQuantityChanged: false,
  rentalChanges: 0,
  messagesSent: 0,
  packingReviewRequired: true,
};
const CLEAN = { ...EXPECTED, itemWrites: 0, productWrites: 0, mappingWrites: 0 };
const execFileAsync = promisify(execFile);

export function convexRunArguments(dryRun) {
  return ["run", FUNCTION_PATH, JSON.stringify({ dryRun }), "--typecheck", "disable", "--codegen", "disable"];
}

export function convexDiagnosticArguments() {
  return ["run", "--inline-query", MIC1_DIAGNOSTIC_QUERY, "--typecheck", "disable", "--codegen", "disable"];
}

export function parseConvexRunOutput(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Convex CLI returned no stock review summary.");
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Convex CLI returned an invalid stock review summary.");
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
    throw new Error("Convex CLI could not complete the production stock review." + (detail ? " " + detail : ""));
  }
}

async function executeConvexDiagnostic({ key }) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [installedToolEntry("convex"), ...convexDiagnosticArguments()], {
      env: { ...process.env, CONVEX_DEPLOY_KEY: key },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return parseConvexRunOutput(stdout);
  } catch {
    throw new Error("The read-only DJI Mic 1 inventory diagnostic could not complete.");
  }
}

function assertPlan(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) throw new Error(`${label} did not match the reviewed DJI Mic 1 repair plan (${key}).`);
  }
}

/** @param {{ dryRun?: boolean, key?: string, execute?: typeof executeConvexRun, diagnose?: typeof executeConvexDiagnostic }} options */
export async function runDjiMic1StockReview({ dryRun, key = process.env.CONVEX_DEPLOY_KEY, execute = executeConvexRun, diagnose = executeConvexDiagnostic } = {}) {
  if (typeof dryRun !== "boolean") throw new Error("A dry-run flag is required.");
  if (!key?.trim()) throw new Error("The protected production credential is unavailable.");
  try {
    return await execute({ dryRun, key });
  } catch (error) {
    if (dryRun && /Reviewed DJI Mic 1 offer master changed/.test(error instanceof Error ? error.message : "")) {
      return { blocked: true, diagnostic: await diagnose({ key }) };
    }
    throw error;
  }
}

export async function reconcileDjiMic1Stock({ apply = false, verifyIdentity = readBackendIdentity, run = runDjiMic1StockReview } = {}) {
  await verifyIdentity();
  const before = await run({ dryRun: true });
  if (before?.blocked === true) return { mode: "blocked", diagnostic: before.diagnostic };
  const alreadyApplied = before?.itemWrites === 0 && before?.productWrites === 0 && before?.mappingWrites === 0;
  assertPlan(before, alreadyApplied ? CLEAN : EXPECTED, "Dry-run");
  if (!apply || alreadyApplied) return { mode: alreadyApplied ? "already-in-sync" : "dry-run", before };

  const applied = await run({ dryRun: false });
  assertPlan(applied, EXPECTED, "Apply");
  const after = await run({ dryRun: true });
  assertPlan(after, CLEAN, "Post-apply dry-run");
  return { mode: "applied-and-verified", before, applied, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.env.APPLY === "true";
  reconcileDjiMic1Stock({ apply })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "The production stock review failed.");
      process.exitCode = 1;
    });
}
