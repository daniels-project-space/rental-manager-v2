import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_cdhxwycwcjdmxnsodsmc",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  // sharp ships a native binary — keep it external so esbuild doesn't try to
  // bundle the .node addon; Trigger installs it (incl. @img/sharp-linux-x64)
  // from package.json in the deploy image.
  build: { external: ["sharp"] },
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
