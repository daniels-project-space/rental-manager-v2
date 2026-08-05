import { defineConfig } from "@trigger.dev/sdk/v3";
import { aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

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
    extensions: [
      aptGet({ packages: ["ca-certificates"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          ["VAULT_ACCESS_TOKEN"]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
});
