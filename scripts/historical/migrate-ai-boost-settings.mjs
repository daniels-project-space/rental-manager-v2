/**
 * Stage 2.5 migration: set ai_boost_rate and ai_active_from in Convex settings.
 * Idempotent — safe to re-run. Reads existing values and only updates if unset.
 * Run: node scripts/historical/migrate-ai-boost-settings.mjs
 *
 * Source for values:
 * - ai_active_from = "2026-02": AI boost activated February 2026 (v1 bot config audit)
 * - ai_boost_rate = 0.33: 33% of revenue attributed to AI boost (v1 parity constant)
 */
import { spawnSync } from 'node:child_process';

const REPO = '/home/ubuntu/rental-manager-v2';

function runConvex(fn, args) {
  const argJson = JSON.stringify(args);
  const r = spawnSync('npx', ['convex', 'run', fn, argJson], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`convex ${fn} failed: ${r.stderr}`);
  const out = r.stdout.trim();
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{') || l.startsWith('[') || l === 'null') {
      return JSON.parse(lines.slice(i).join('\n'));
    }
  }
  return null;
}

const settings = runConvex('settings:get', {});
const hasBoostRate = settings && typeof settings.ai_boost_rate === 'number';
const hasActiveFrom = settings && typeof settings.ai_active_from === 'string';

if (hasBoostRate && hasActiveFrom) {
  console.log(`Already set: ai_boost_rate=${settings.ai_boost_rate} ai_active_from=${settings.ai_active_from}`);
  process.exit(0);
}

const patch = {};
if (!hasBoostRate) patch.ai_boost_rate = 0.33;
if (!hasActiveFrom) patch.ai_active_from = '2026-02';

const result = runConvex('settings:update', patch);
console.log('Updated:', patch, '-> result:', result);

const verify = runConvex('settings:get', {});
console.log(`Verified: ai_boost_rate=${verify.ai_boost_rate} ai_active_from=${verify.ai_active_from}`);
