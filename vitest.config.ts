import { defineConfig } from "vitest/config";

/**
 * Minimal vitest config — Wave 1 unit tests only.
 *
 * Node environment (no jsdom, no Convex test runtime). Targets the
 * mastra/lib units that are pure TS + injectable stubs.
 *
 * CSS / PostCSS pipeline is disabled — the project's `postcss.config.mjs`
 * uses Tailwind v4's async plugin loader, which the CJS Vite shipped with
 * vitest 1.x can't evaluate. Unit tests don't touch CSS, so we short-circuit.
 */
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/mastra/**/*.test.ts",
      "convex/lib/item_matcher.test.ts",
      "convex/lib/revenue_attribution.test.ts",
      "convex/lib/denial_classifier.test.ts",
      "convex/lib/availability.test.ts",
    ],
    css: false,
  },
});
