import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renterBotLabBackendSourceFingerprint } from "./renter-bot-lab-backend-revision.mjs";

export type RenterBotLabSourceEnvironment = Record<string, string | undefined>;

const LOCAL_SOURCE_ROOTS = ["src", "convex"] as const;
const LOCAL_SOURCE_CONFIG = ["package.json", "pnpm-lock.yaml", "next.config.js", "next.config.mjs", "next.config.ts", "convex.config.ts", "tsconfig.json"] as const;

/** Hash the source served by the local UI and generator, including dirty files. */
function localSourceFingerprint(): string | null {
  try {
    const root = process.cwd();
    const hash = createHash("sha256");
    const files: string[] = [];
    const visit = (relative: string) => {
      const absolute = join(root, relative);
      if (!existsSync(absolute)) return;
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        for (const child of readdirSync(absolute).sort()) visit(join(relative, child));
      } else if (stat.isFile()) files.push(relative);
    };
    for (const path of LOCAL_SOURCE_ROOTS) visit(path);
    for (const path of LOCAL_SOURCE_CONFIG) visit(path);
    if (!files.length) return null;
    for (const file of files.sort()) {
      hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** A non-secret revision that can be compared between the Lab page and draft API. */
export function renterBotLabSourceRevision(env: RenterBotLabSourceEnvironment): string {
  if (env.RENTER_BOT_LAB_DEPLOYMENT === "local" && env.NODE_ENV === "development") {
    if (env.RENTER_BOT_LAB_SOURCE_REVISION && /^local:[a-f0-9]{12,64}$/i.test(env.RENTER_BOT_LAB_SOURCE_REVISION)) {
      return env.RENTER_BOT_LAB_SOURCE_REVISION;
    }
    const fingerprint = localSourceFingerprint();
    return fingerprint ? `local:${fingerprint.slice(0, 20)}` : "local-source-unavailable";
  }
  if (env.VERCEL_GIT_COMMIT_SHA && /^[a-f0-9]{7,40}$/i.test(env.VERCEL_GIT_COMMIT_SHA)) {
    return env.VERCEL_GIT_COMMIT_SHA;
  }
  if (env.RENTER_BOT_LAB_SOURCE_REVISION && /^local:[a-f0-9]{12,64}$/i.test(env.RENTER_BOT_LAB_SOURCE_REVISION)) {
    return env.RENTER_BOT_LAB_SOURCE_REVISION;
  }
  if (env.VERCEL_URL) return `deployment:${env.VERCEL_URL}`;
  return env.NODE_ENV === "development" ? "local-development-unpinned" : "fingerprint-only";
}

export function renterBotLabSourceFingerprint(env: RenterBotLabSourceEnvironment): string | null {
  if (env.RENTER_BOT_LAB_DEPLOYMENT === "local" && env.NODE_ENV === "development") {
    if (env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT && /^[a-f0-9]{64}$/.test(env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT)) {
      return env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT;
    }
    return localSourceFingerprint();
  }
  if (env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT && /^[a-f0-9]{64}$/.test(env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT)) {
    return env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT;
  }
  const source = env.VERCEL_GIT_COMMIT_SHA ?? env.RENTER_BOT_LAB_SOURCE_REVISION ?? env.VERCEL_URL ??
    (env.NODE_ENV === "development" ? "local-development-unpinned" : undefined);
  return source ? createHash("sha256").update(source).digest("hex") : null;
}

/** Expected Convex runtime source fingerprint, independent of the Next/API revision. */
export function renterBotLabBackendSourceRevision(_env: RenterBotLabSourceEnvironment): string {
  return renterBotLabBackendSourceFingerprint() ?? "backend-source-unavailable";
}
