import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_cdhxwycwcjdmxnsodsmc",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  // Retry sane defaults — individual tasks can override.
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
  build: {
    external: ["@openai/codex"],
    extensions: [
      additionalPackages({ packages: ["@openai/codex@latest"] }),
      aptGet({ packages: ["ca-certificates"] }),
      syncEnvVars(() => {
        const value = process.env.CODEX_AUTH_JSON_B64;
        return value ? { CODEX_AUTH_JSON_B64: value } : undefined;
      }),
    ],
  },
});
