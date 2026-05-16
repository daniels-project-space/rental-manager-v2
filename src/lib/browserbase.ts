/**
 * Wave 3c — Stagehand + Browserbase client adapter.
 *
 * Replaces brittle Playwright selectors in `src/trigger/hygglo-ui-action.ts`
 * with Stagehand's structured `act()` / `extract({schema})` calls running
 * against Browserbase cloud sessions.
 *
 * Env vars (sourced from project-hub Convex vault, set in Trigger env):
 *   - BROWSERBASE_API_KEY   (never inline; vault-managed)
 *   - BROWSERBASE_PROJECT_ID
 *   - USE_STAGEHAND=1       (flag-gated rollout; OFF by default this phase)
 *
 * Cost note: Browserbase bills per session (~$0.05/session as of May 2026).
 * We CACHE one Stagehand instance per accountSlug so consecutive UI actions
 * against the same Hygglo seller account reuse a single browser session
 * instead of spinning a fresh one per action. Without reuse, a 10-action
 * batch on `dbcinema` would cost ~$0.50; with reuse it stays at ~$0.05.
 *
 * Lifecycle:
 *   - `getStagehand(accountSlug)` — lazy init + cache (singleton-per-slug)
 *   - `releaseStagehand(accountSlug)` — explicit close (call from task end)
 *   - `isStagehandEnabled()` — env flag check; callers gate on this
 */

// Lazy import: keep this module type-only at the top so import cost is
// zero when USE_STAGEHAND is OFF. The `Stagehand` class is loaded inside
// `getStagehand()` only.
type StagehandModule = typeof import("@browserbasehq/stagehand");
type StagehandInstance = InstanceType<StagehandModule["Stagehand"]>;

/** Per-account cache. Keyed by `accountSlug` ("dbcinema" | "leo" | ...). */
const cache = new Map<string, Promise<StagehandInstance>>();

/**
 * Returns true when the Stagehand rewrite path is enabled.
 * Default OFF this phase — Playwright fallback runs unless flipped.
 */
export function isStagehandEnabled(): boolean {
  return (process.env.USE_STAGEHAND ?? "").toLowerCase() === "1"
    || (process.env.USE_STAGEHAND ?? "").toLowerCase() === "true";
}

interface BrowserbaseEnv {
  apiKey: string;
  projectId: string;
}

function readEnv(): BrowserbaseEnv {
  const apiKey = process.env.BROWSERBASE_API_KEY ?? "";
  const projectId = process.env.BROWSERBASE_PROJECT_ID ?? "";
  if (!apiKey) {
    throw new Error(
      "BROWSERBASE_API_KEY missing — set via project-hub vault / Trigger env. " +
      "Never inline. For local dev add to .env.local."
    );
  }
  if (!projectId) {
    throw new Error(
      "BROWSERBASE_PROJECT_ID missing — set via project-hub vault / Trigger env."
    );
  }
  return { apiKey, projectId };
}

/**
 * Get (or lazily create) a Stagehand instance for the given account slug.
 * Sessions are cached — re-calling with the same `accountSlug` returns the
 * existing browser session, which keeps cost flat across a batch of UI
 * actions on the same Hygglo seller account.
 *
 * @param accountSlug - "dbcinema" | "leo" | other slug bound to seller cookies
 */
export async function getStagehand(accountSlug: string): Promise<StagehandInstance> {
  const cached = cache.get(accountSlug);
  if (cached) return cached;

  const promise = (async () => {
    const { apiKey, projectId } = readEnv();
    const mod = (await import("@browserbasehq/stagehand")) as StagehandModule;
    // Use a constructor-flexible cast: Stagehand's options shape varies by
    // minor version (env / apiKey / projectId / modelName etc.). The fields
    // below are the stable surface as of May 2026.
    const StagehandCtor = mod.Stagehand as unknown as new (opts: Record<string, unknown>) => StagehandInstance;
    const sh = new StagehandCtor({
      env: "BROWSERBASE",
      apiKey,
      projectId,
      // modelName left undefined → Stagehand default (gpt-4o family).
      // We can swap to grok-vision later via env var if needed.
    });
    await (sh as unknown as { init: () => Promise<unknown> }).init();
    return sh;
  })();

  cache.set(accountSlug, promise);
  return promise;
}

/**
 * Close + drop the cached Stagehand session for `accountSlug`.
 * Call at the end of a Trigger task run (or on failure) so the Browserbase
 * session is released and we don't leak across runs.
 */
export async function releaseStagehand(accountSlug: string): Promise<void> {
  const promise = cache.get(accountSlug);
  if (!promise) return;
  cache.delete(accountSlug);
  try {
    const sh = await promise;
    await (sh as unknown as { close?: () => Promise<unknown> }).close?.();
  } catch {
    // Best-effort — release should never throw into the caller.
  }
}

/**
 * Test hook: clear the cache without closing browsers (Vitest / unit-test
 * use only; production paths must call `releaseStagehand`).
 */
export function __resetStagehandCacheForTests(): void {
  cache.clear();
}
