import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_cdhxwycwcjdmxnsodsmc",
  runtime: "node",
  logLevel: "log",
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
});
