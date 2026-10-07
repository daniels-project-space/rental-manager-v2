/** Read-only deployment preflight. Never publishes, flips gates, imports bookings or prints credentials. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const deployment = 'hearty-oyster-600';
// Require an independently verified live binding rather than silently trusting a historic deployment.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--website-url' || !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(args[1])) {
  console.error('Usage: node scripts/check-dbc-live-readiness.mjs --website-url https://<verified-live-deployment>.convex.cloud');
  process.exit(2);
}
const expectedUrl = args[1];
const expectedDeployment = new URL(expectedUrl).hostname.split('.')[0];
function command(args, target = deployment) {
  try { return { ok: true, value: execFileSync('npx', ['convex', ...args, '--deployment', target], { cwd, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch { return { ok: false }; }
}
function control(name) {
  const result = command(['env', 'get', name]);
  return result.ok && ['true', 'false'].includes(result.value) ? result.value === 'true' : null;
}
const website = command(['env', 'get', 'DBCINEMA_CONVEX_URL']);
let websiteUrl = null;
try {
  const value = new URL(website.value);
  if (value.protocol === 'https:' && !value.username && !value.password && /^[a-z0-9-]+\.convex\.cloud$/.test(value.hostname)) websiteUrl = value.origin;
} catch {}
const ownerRead = command(['run', '--inline-query', 'const owner = await ctx.db.query("owner_access").first(); return { registered: !!owner, hasAuthBinding: !!owner?.auth_user_id };', '--codegen', 'disable', '--typecheck', 'disable']);
let owner = null;
if (ownerRead.ok) try { const value = JSON.parse(ownerRead.value); if (typeof value.registered === 'boolean' && typeof value.hasAuthBinding === 'boolean') owner = value; } catch {}
const required = control('OWNER_AUTH_REQUIRED');
const returnWrites = control('ALLOW_WEBSITE_RETURN_WRITES');
const managerSecret = command(['env', 'get', 'DBCINEMA_ADMIN_TOKEN']);
const websiteSecret = command(['env', 'get', 'ADMIN_TOKEN'], expectedDeployment);
const secretValue = result => result.ok && result.value && !/not set|not found|undefined/i.test(result.value) ? result.value : null;
const first = secretValue(managerSecret), second = secretValue(websiteSecret);
const digest = value => createHash('sha256').update(value).digest('hex');
const adminTokenMatches = first && second ? digest(first) === digest(second) : null;
const blockers = [];
if (!owner?.registered || !owner?.hasAuthBinding) blockers.push('private-owner-account-not-verified');
if (required !== true) blockers.push('operational-owner-protection-not-enforced');
if (websiteUrl !== expectedUrl) blockers.push('manager-does-not-target-live-website-backend');
if (adminTokenMatches !== true) blockers.push(adminTokenMatches === false ? 'website-admin-credential-mismatch' : 'website-admin-credential-not-verifiable');
const result = { checkedAt: new Date().toISOString(), deployment, owner, ownerProtectionRequired: required,
  websiteUrl, expectedWebsiteUrl: expectedUrl, websiteAdminTokenMatches: adminTokenMatches,
  websiteReturnWritesEnabled: returnWrites, blockers, readyForPrivateWebsiteIntegration: blockers.length === 0,
  financialExecutionAuthorizedByThisCheck: false, productionWrites: false };
console.log(JSON.stringify(result, null, 2));
if (blockers.length) process.exitCode = 1;
