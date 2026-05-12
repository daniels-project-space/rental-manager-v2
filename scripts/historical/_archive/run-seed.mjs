// Drives Convex seed mutations. Reads /tmp/seed-payloads.json and runs each
// internalMutation via convex CLI run.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const payload = JSON.parse(readFileSync('/tmp/seed-payloads.json', 'utf8'));
const PAT = process.env.CONVEX_OVERRIDE_ACCESS_TOKEN;
if (!PAT) {
  console.error('CONVEX_OVERRIDE_ACCESS_TOKEN required');
  process.exit(1);
}

function runFn(fn, args = {}) {
  // Convex CLI accepts JSON args via --push-args or stdin. Easiest: stdin.
  const argsFile = `/tmp/seed-args-${fn.replace(/[\/:]/g, '_')}.json`;
  writeFileSync(argsFile, JSON.stringify(args));
  const cmd = `cd /home/ubuntu/rental-manager-v2 && CONVEX_OVERRIDE_ACCESS_TOKEN='${PAT}' npx convex run ${fn} --no-push -- $(cat ${argsFile})`;
  // Fallback: use stdin
  try {
    const out = execSync(`cd /home/ubuntu/rental-manager-v2 && CONVEX_OVERRIDE_ACCESS_TOKEN='${PAT}' npx convex run ${fn}`, {
      input: JSON.stringify(args),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[OK] ${fn}:`, out.trim());
    return JSON.parse(out.trim().split('\n').pop() || '{}');
  } catch (e) {
    console.error(`[ERR] ${fn}:`, e.stderr?.toString() || e.message);
    throw e;
  }
}

const order = [
  ['seed/inventory:seedAccounts', {}],
  ['seed/inventory:seedSettings', {}],
  ['seed/inventory:seedItems', { items: payload.items }],
  ['seed/inventory:seedItemSpecs', { specs: payload.specs }],
  ['seed/inventory:seedBundles', { bundles: payload.bundles }],
  ['seed/inventory:seedMarketingRedirects', { redirects: payload.redirects }],
  ['seed/inventory:seedPricingCatalog', { rows: payload.pricing }],
  ['seed/inventory:seedListingPhotos', { rows: payload.listingPhotos }],
  ['seed/inventory:verifyCounts', {}],
];

const results = {};
for (const [fn, args] of order) {
  results[fn] = runFn(fn, args);
}
writeFileSync('/tmp/seed-results.json', JSON.stringify(results, null, 2));
console.log('\n=== ALL DONE ===');
console.log(JSON.stringify(results['seed/inventory:verifyCounts'], null, 2));
