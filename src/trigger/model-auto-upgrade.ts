/**
 * Wave 4.7 — monthly Grok model auto-upgrade scanner.
 *
 * Cron: `23 9 1 * *` (1st of each month at 09:23 UTC — off-the-minute
 * per Daniel's token-efficient scheduling guidance).
 *
 * Steps:
 *   1. Read currently pinned chat model from src/lib/ai-models.ts
 *      (DEFAULT_GROK_CHAT_MODEL constant — single source of truth).
 *   2. Fetch GET https://api.x.ai/v1/models with Bearer $XAI_API_KEY
 *      (OpenAI-compatible endpoint).
 *   3. Filter to `grok-*` ids; run `decideRecommendation()` from
 *      src/lib/model-version.ts.
 *   4. Record outcome in Convex `model_upgrade_scans`.
 *   5. If outcome === "auto_pr" AND GITHUB_TOKEN is set: open a PR
 *      that rewrites DEFAULT_GROK_CHAT_MODEL in ai-models.ts.
 *      Branch: `chore/auto-grok-bump-<YYYYMMDD>`.
 *      Optionally auto-merge when env AUTO_MERGE_MODEL_BUMPS=true.
 *   6. If outcome === "advisory": just record — surfaced via the
 *      `get_model_upgrade_advisories` Mastra tool.
 *
 * Env vars consumed:
 *   - XAI_API_KEY   (required)
 *   - CONVEX_URL    (required, prod deployment URL)
 *   - GITHUB_TOKEN  (optional; missing → auto_pr downgraded to advisory)
 *   - AUTO_MERGE_MODEL_BUMPS=true (optional; default false)
 *   - GITHUB_REPO   (optional; default 'daniels-project-space/rental-manager-v2')
 *   - GITHUB_BASE_BRANCH (optional; default 'main')
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import {
  DEFAULT_GROK_CHAT_MODEL,
} from "../lib/ai-models";
import { decideRecommendation } from "../lib/model-version";

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

const GH_REPO =
  process.env.GITHUB_REPO ?? "daniels-project-space/rental-manager-v2";
const GH_BASE = process.env.GITHUB_BASE_BRANCH ?? "main";
const AI_MODELS_PATH = "src/lib/ai-models.ts";

interface XaiModelsResponse {
  data?: Array<{ id: string }>;
}

/** Fetch the full Grok model id list from xAI. Returns sorted unique ids. */
async function fetchAvailableGrokModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.x.ai/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `xAI /v1/models returned HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as XaiModelsResponse;
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => id.toLowerCase().startsWith("grok-"));
  return Array.from(new Set(ids)).sort();
}

// ── GitHub REST helpers ─────────────────────────────────────────
// Implemented as raw fetch calls (no @octokit dep required; keeps the
// task bundle small).

async function gh(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "rental-manager-v2-model-auto-upgrade",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function ghJson<T = unknown>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await gh(token, path, init);
  if (!res.ok) {
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Rewrite the DEFAULT_GROK_CHAT_MODEL literal in ai-models.ts and open a PR.
 * Returns the PR URL.
 */
async function openAutoBumpPr(
  token: string,
  fromModel: string,
  toModel: string,
  availableModels: string[],
): Promise<string> {
  // 1. Fetch current ai-models.ts contents from main.
  const fileRes = await ghJson<{ content: string; sha: string }>(
    token,
    `/repos/${GH_REPO}/contents/${encodeURIComponent(AI_MODELS_PATH)}?ref=${encodeURIComponent(GH_BASE)}`,
  );
  const currentContent = Buffer.from(fileRes.content, "base64").toString("utf8");

  // Rewrite the DEFAULT_GROK_CHAT_MODEL literal ONLY. We intentionally
  // do not rewrite the GROK_CHAT_MODEL/GROK_VISION_MODEL env-fallback
  // lines — operators can already override per deployment.
  const re =
    /(export const DEFAULT_GROK_CHAT_MODEL\s*=\s*")grok-[^"]+(";)/;
  if (!re.test(currentContent)) {
    throw new Error(
      "Could not find DEFAULT_GROK_CHAT_MODEL literal in ai-models.ts — schema drift?",
    );
  }
  const newContent = currentContent.replace(re, `$1${toModel}$2`);
  if (newContent === currentContent) {
    throw new Error("Rewrite produced identical content; aborting PR.");
  }

  // 2. Get the SHA of main's HEAD.
  const baseRef = await ghJson<{ object: { sha: string } }>(
    token,
    `/repos/${GH_REPO}/git/refs/heads/${encodeURIComponent(GH_BASE)}`,
  );

  // 3. Create branch `chore/auto-grok-bump-<YYYYMMDD>`.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const branchName = `chore/auto-grok-bump-${today}`;

  await gh(token, `/repos/${GH_REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha,
    }),
  }); // 422 if branch exists — fine, we'll just push to it via PUT contents below.

  // 4. PUT the updated file on the new branch.
  await ghJson(token, `/repos/${GH_REPO}/contents/${encodeURIComponent(AI_MODELS_PATH)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `chore: auto-bump GROK_CHAT_MODEL to ${toModel} (monthly scan)`,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      branch: branchName,
      sha: fileRes.sha,
    }),
  });

  // 5. Open the PR.
  const pr = await ghJson<{ html_url: string; number: number }>(
    token,
    `/repos/${GH_REPO}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: `chore: auto-bump GROK_CHAT_MODEL to ${toModel} (monthly scan)`,
        head: branchName,
        base: GH_BASE,
        body: [
          `## Monthly Grok model auto-upgrade scan`,
          ``,
          `- **From:** \`${fromModel}\``,
          `- **To:** \`${toModel}\``,
          `- **Available models** (\`GET https://api.x.ai/v1/models\`):`,
          ``,
          ...availableModels.map((m) => `  - \`${m}\``),
          ``,
          `Auto-generated by \`src/trigger/model-auto-upgrade.ts\`. ` +
            `Recommendation policy: same MAJOR + higher MINOR + same SKU shape → auto-PR.`,
          ``,
          `Major-version bumps and SKU surface changes route to \`advisory\` instead ` +
            `and are surfaced in the dashboard chat agent via \`get_model_upgrade_advisories\`.`,
        ].join("\n"),
      }),
    },
  );

  // 6. Optional auto-merge.
  if ((process.env.AUTO_MERGE_MODEL_BUMPS ?? "").toLowerCase() === "true") {
    try {
      await gh(token, `/repos/${GH_REPO}/pulls/${pr.number}/merge`, {
        method: "PUT",
        body: JSON.stringify({
          merge_method: "squash",
          commit_title: `chore: auto-bump GROK_CHAT_MODEL to ${toModel}`,
        }),
      });
    } catch (e) {
      logger.warn(
        `[model-auto-upgrade] auto-merge failed (PR ${pr.number}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return pr.html_url;
}

// ── Task ──────────────────────────────────────────────────────

export const modelAutoUpgradeScan = schedules.task({
  id: "model-auto-upgrade-scan",
  cron: "23 9 1 * *",
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    const scannedAt = Date.now();
    const apiKey = process.env.XAI_API_KEY ?? "";
    const ghToken = process.env.GITHUB_TOKEN ?? "";
    const convex = new ConvexHttpClient(CONVEX_URL);
    const currentModel = DEFAULT_GROK_CHAT_MODEL;

    if (!apiKey) {
      const errorMessage = "XAI_API_KEY is not set; cannot scan models.";
      logger.error(`[model-auto-upgrade] ${errorMessage}`);
      await convex.mutation(api.model_upgrade_scans.recordScan, {
        scannedAt,
        currentModel,
        availableModels: [],
        recommendation: "error",
        errorMessage,
      });
      return { recommendation: "error" };
    }

    let availableModels: string[] = [];
    try {
      availableModels = await fetchAvailableGrokModels(apiKey);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error(`[model-auto-upgrade] xAI fetch failed: ${errorMessage}`);
      await convex.mutation(api.model_upgrade_scans.recordScan, {
        scannedAt,
        currentModel,
        availableModels: [],
        recommendation: "error",
        errorMessage,
      });
      return { recommendation: "error" };
    }

    const outcome = decideRecommendation(currentModel, availableModels);
    logger.info(
      `[model-auto-upgrade] current=${currentModel} outcome=${outcome.recommendation} recommended=${outcome.recommendedModel ?? "-"} reason="${outcome.reason}"`,
    );

    // auto_pr path — but degrade to advisory when GITHUB_TOKEN is missing.
    if (outcome.recommendation === "auto_pr") {
      if (!ghToken) {
        await convex.mutation(api.model_upgrade_scans.recordScan, {
          scannedAt,
          currentModel,
          availableModels,
          recommendation: "advisory",
          recommendedModel: outcome.recommendedModel ?? undefined,
          errorMessage:
            "Auto-PR recommended but GITHUB_TOKEN is not set; surfacing as advisory instead.",
        });
        return { recommendation: "advisory", recommendedModel: outcome.recommendedModel };
      }

      try {
        const prUrl = await openAutoBumpPr(
          ghToken,
          currentModel,
          outcome.recommendedModel!,
          availableModels,
        );
        await convex.mutation(api.model_upgrade_scans.recordScan, {
          scannedAt,
          currentModel,
          availableModels,
          recommendation: "auto_pr",
          recommendedModel: outcome.recommendedModel ?? undefined,
          prUrl,
        });
        return { recommendation: "auto_pr", prUrl };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error(`[model-auto-upgrade] PR creation failed: ${errorMessage}`);
        await convex.mutation(api.model_upgrade_scans.recordScan, {
          scannedAt,
          currentModel,
          availableModels,
          recommendation: "error",
          recommendedModel: outcome.recommendedModel ?? undefined,
          errorMessage,
        });
        return { recommendation: "error", error: errorMessage };
      }
    }

    // advisory / no_change paths — just record.
    await convex.mutation(api.model_upgrade_scans.recordScan, {
      scannedAt,
      currentModel,
      availableModels,
      recommendation: outcome.recommendation,
      recommendedModel: outcome.recommendedModel ?? undefined,
    });
    return {
      recommendation: outcome.recommendation,
      recommendedModel: outcome.recommendedModel,
    };
  },
});
