import { defineConfig } from "vitest/config";

/**
 * Standalone vitest config for the hygglo-core Phase 1 parity tests.
 *
 * The root `vitest.config.ts` uses an explicit `include` allowlist; this file
 * is a NEW, additive config (Phase 1 must not edit existing files) that runs
 * ONLY the hygglo-core suite. Run with:
 *   npx vitest run --config src/hygglo-core/__tests__/vitest.config.ts
 *
 * Same node environment + CSS short-circuit as the root config.
 */
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    globals: false,
    root: process.cwd(),
    include: ["src/hygglo-core/**/*.test.ts"],
    css: false,
  },
});
