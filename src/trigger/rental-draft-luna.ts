import { task } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

function codexBinary(): string {
  const pkgJson = nodeRequire.resolve("@openai/codex/package.json");
  const pkgDir = dirname(pkgJson);
  const nodeModules = dirname(dirname(pkgDir));
  const candidates = [join(nodeModules, ".bin", "codex")];
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codex;
  if (rel) candidates.push(join(pkgDir, rel));
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Codex CLI is not installed in the Trigger image");
  return found;
}

function subscriptionEnv(): NodeJS.ProcessEnv {
  const home = "/tmp/rental-codex-home";
  mkdirSync(home, { recursive: true });
  const encoded = process.env.CODEX_AUTH_JSON_B64;
  const raw = process.env.CODEX_AUTH_JSON;
  if (encoded || raw) {
    const json = encoded ? Buffer.from(encoded, "base64").toString("utf8") : raw!;
    JSON.parse(json);
    writeFileSync(join(home, "auth.json"), json, { mode: 0o600 });
    chmodSync(join(home, "auth.json"), 0o600);
  }
  if (!process.env.CODEX_ACCESS_TOKEN && !encoded && !raw) {
    throw new Error("Codex ChatGPT subscription auth is not configured");
  }
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: home,
    // Never allow a silent switch to separately billed Platform API credits.
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
  };
}

function runLuna(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      codexBinary(),
      [
        "exec",
        "--model",
        "gpt-5.6-luna",
        "--config",
        'model_reasoning_effort="low"',
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--json",
        prompt,
      ],
      { cwd: "/tmp", env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let finalText = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            finalText = event.item.text ?? finalText;
          }
        } catch {
          // Ignore non-event output; Codex's final agent message is JSONL.
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), 55_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !finalText.trim()) {
        reject(new Error(`Luna draft failed (${code}): ${stderr.slice(-400)}`));
        return;
      }
      resolve(finalText.trim());
    });
  });
}

function parseDecision(text: string): { draft: string; needs_human: boolean } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Luna returned no JSON decision");
  const value = JSON.parse(fenced.slice(start, end + 1)) as {
    draft?: unknown;
    needs_human?: unknown;
  };
  return {
    draft: typeof value.draft === "string" ? value.draft.trim() : "",
    needs_human: value.needs_human === true,
  };
}

export const rentalDraftLuna = task({
  id: "rental-draft-luna",
  maxDuration: 60,
  retry: { maxAttempts: 1 },
  run: async (payload: { prompt: string }) => {
    const decision = parseDecision(await runLuna(payload.prompt));
    return { ...decision, model: "gpt-5.6-luna", auth: "chatgpt_subscription" as const };
  },
});
