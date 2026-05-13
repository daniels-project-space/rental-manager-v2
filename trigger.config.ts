import { defineConfig } from "@trigger.dev/sdk/v3";
import { playwright } from "@trigger.dev/build/extensions/playwright";
import { additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";

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
  // Wave 4.6 — Hygglo UI automation runs browser-use (Python) inside the
  // Trigger task container.
  //   * playwright extension      → Chromium binaries + Node deps
  //   * aptGet python3 + venv     → Python runtime for browser-use
  //   * postInstall pip            → installs from requirements.txt
  build: {
    extensions: [
      playwright({ browsers: ["chromium"], version: "1.49.0" }),
      aptGet({ packages: ["python3", "python3-pip", "python3-venv"] }),
      additionalPackages({
        // Node-side helper: AWS S3 client used to upload shadow screenshots to R2.
        packages: ["@aws-sdk/client-s3@^3.700.0"],
      }),
    ],
  },
});
