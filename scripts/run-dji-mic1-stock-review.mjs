import { pathToFileURL } from "node:url";
import { BACKEND_URL, readBackendIdentity } from "./backend-publisher.mjs";

const FUNCTION_PATH = "seed/dji_mic1_stock_review:apply";
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

function assertPlan(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) throw new Error(`${label} did not match the reviewed DJI Mic 1 repair plan (${key}).`);
  }
}

/** @param {{ dryRun?: boolean, key?: string, request?: typeof fetch }} options */
export async function runDjiMic1StockReview({ dryRun, key = process.env.CONVEX_DEPLOY_KEY, request = fetch } = {}) {
  if (typeof dryRun !== "boolean") throw new Error("A dry-run flag is required.");
  if (!key?.trim()) throw new Error("The protected production credential is unavailable.");
  const response = await request(`${BACKEND_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${key}` },
    body: JSON.stringify({ path: FUNCTION_PATH, args: [{ dryRun }], format: "convex_encoded_json" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The production stock review failed with HTTP ${response.status}.`);
  const result = await response.json();
  if (result.status !== "success") throw new Error("The production stock review returned an unsuccessful result.");
  return result.value;
}

export async function reconcileDjiMic1Stock({ apply = false, verifyIdentity = readBackendIdentity, run = runDjiMic1StockReview } = {}) {
  await verifyIdentity();
  const before = await run({ dryRun: true });
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
