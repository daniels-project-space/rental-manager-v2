#!/usr/bin/env node
/**
 * Wave 4 — mirror-sync CI.
 *
 * Diffs SHARED constants between:
 *   src/mastra/data/constants.ts   (source of truth — used by Mastra)
 *   convex/mv/constants.ts         (mirror — used by Convex MV refreshers)
 *
 * Mirror keys (must match byte-for-byte):
 *   PLATFORM_FEE_RATE
 *   OWNER_SHARE
 *   ACCOUNTS              (array literal)
 *
 * Exits 1 on divergence. Used by `npm run check:mirror`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src/mastra/data/constants.ts");
const MIRROR = resolve(ROOT, "convex/mv/constants.ts");

const KEYS = ["PLATFORM_FEE_RATE", "OWNER_SHARE", "ACCOUNTS"];

/**
 * Extract `export const KEY = <value>;` for each key.
 * Tolerates whitespace and trailing comments; captures raw RHS until `;`.
 */
function extractValues(text, keys) {
  const out = {};
  for (const key of keys) {
    const re = new RegExp(
      `export\\s+const\\s+${key}\\s*=\\s*([\\s\\S]*?);`,
      "m",
    );
    const m = re.exec(text);
    if (!m) {
      out[key] = null;
      continue;
    }
    // Normalize whitespace + strip ` as const` for ACCOUNTS comparison.
    out[key] = m[1]
      .replace(/\s+as\s+const/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return out;
}

const [srcText, mirrorText] = await Promise.all([
  readFile(SRC, "utf8"),
  readFile(MIRROR, "utf8"),
]);

const src = extractValues(srcText, KEYS);
const mirror = extractValues(mirrorText, KEYS);

const failures = [];
for (const key of KEYS) {
  if (src[key] === null) failures.push(`MISSING in src/mastra/data/constants.ts: ${key}`);
  if (mirror[key] === null) failures.push(`MISSING in convex/mv/constants.ts: ${key}`);
  if (src[key] !== null && mirror[key] !== null && src[key] !== mirror[key]) {
    failures.push(
      `DIVERGED ${key}:\n  src    = ${src[key]}\n  mirror = ${mirror[key]}`,
    );
  }
}

if (failures.length > 0) {
  console.error("ERROR: convex/mv/constants.ts is OUT OF SYNC with src/mastra/data/constants.ts");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(`OK: all ${KEYS.length} mirrored constants match.`);
