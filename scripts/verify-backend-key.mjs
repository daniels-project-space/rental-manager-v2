// A read-only main-branch check against the existing production status query.
// This also works before the new deployment-identity functions are bootstrapped.
const key = process.env.CONVEX_DEPLOY_KEY;
if (!key?.trim()) throw Error("Private backend deployment credential is missing");
const response = await fetch("https://hearty-oyster-600.convex.cloud/api/query", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Convex ${key}` },
  body: JSON.stringify({ path: "stock_input_cache_admin:status", args: [{}], format: "convex_encoded_json" }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw Error(`Production backend credential check failed (${response.status})`);
const result = await response.json();
if (result.status !== "success") throw Error("Credential cannot read the intended production backend");
console.log("Private backend credential verified for hearty-oyster-600; no application records changed.");
