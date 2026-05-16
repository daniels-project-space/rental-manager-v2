/**
 * Rule-based intent classifier for the dashboard chat router.
 *
 * Phase 3b W3: routes simple-read questions to the cheaper grok-4-fast
 * model and reserves grok-4.3 for complex reasoning / mutations.
 *
 * Default-on-uncertainty: `unknown` — caller MUST treat as full-model
 * (grok-4.3). Bias: when in doubt, prefer `complex` / `unknown` over
 * `simple_read` so we never silently downgrade a hard turn.
 */

export type ChatIntent = "simple_read" | "complex" | "mutation" | "unknown";

export type IntentHistoryEntry = {
  role: "user" | "assistant" | "system";
  content: string;
  /** Optional structured metadata persisted on assistant turns. */
  metadata?: string | null;
};

// ── Keyword sets ──────────────────────────────────────────────
// Order of checks matters: mutation > complex > simple_read.
// Each list is intentionally conservative — anything not matched
// falls through to `unknown` → grok-4.3.

const MUTATION_KEYWORDS = [
  "accept",
  "decline",
  "reject",
  "approve",
  "discount",
  "mark as",
  "mark it",
  "delete",
  "remove",
  "cancel",
  "set ",
  "update",
  "change ",
  "edit ",
  "create ",
  "send ",
  "message ",
  "block ",
  "ban ",
];

const COMPLEX_KEYWORDS = [
  "compare",
  "why",
  "should i",
  "explain",
  "analyz",
  "recommend",
  "diagnose",
  "root cause",
  "break down",
  "deep dive",
  "tradeoff",
  "what if",
  "predict",
  "forecast",
  "trend",
  "strategy",
  "optimi",
  "audit",
];

const SIMPLE_READ_KEYWORDS = [
  "what's",
  "what is",
  "how much",
  "how many",
  "show me",
  "show ",
  "list ",
  "today's",
  "today ",
  "this week",
  "this month",
  "earnings",
  "revenue",
  "briefing",
  "pending",
  "overdue",
  "upcoming",
  "current",
  "status",
  "summary",
  "who ",
  "when ",
  "where ",
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

/**
 * Inspect recent assistant turn(s) for a `mutate` tool call signal. We
 * persist tool-call summaries in `metadata`, so a simple substring scan
 * is enough. If the last assistant turn called `mutate`, follow-up
 * questions tend to be confirmations/clarifications — bump those to
 * `complex` so they get the full model.
 */
function recentMutateContext(history: readonly IntentHistoryEntry[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant") continue;
    const md = h.metadata ?? "";
    const body = h.content ?? "";
    if (
      md.includes("\"mutate\"") ||
      md.includes("'mutate'") ||
      body.includes("mutate(") ||
      /\bmutate\b/.test(md)
    ) {
      return true;
    }
    // Only inspect the most recent assistant turn.
    break;
  }
  return false;
}

/**
 * Classify a user message into one of four routing buckets.
 *
 * Rules (in order):
 *   1. Empty / whitespace → `unknown`.
 *   2. Mutation keyword → `mutation`.
 *   3. Long message (>240 chars) → `complex` (long prompts ~= multi-part).
 *   4. Question with multiple sentences (≥3 sentence-enders) → `complex`.
 *   5. Complex keyword → `complex`.
 *   6. Recent assistant `mutate` tool call → `complex` (follow-up bias).
 *   7. Simple-read keyword → `simple_read`.
 *   8. Otherwise → `unknown`.
 */
export function classifyIntent(
  userMessage: string,
  history: readonly IntentHistoryEntry[] = [],
): ChatIntent {
  const raw = (userMessage ?? "").trim();
  if (raw.length === 0) return "unknown";
  const lower = raw.toLowerCase();

  if (containsAny(lower, MUTATION_KEYWORDS)) return "mutation";

  if (raw.length > 240) return "complex";

  const sentenceCount = (raw.match(/[.!?]/g) ?? []).length;
  if (sentenceCount >= 3) return "complex";

  if (containsAny(lower, COMPLEX_KEYWORDS)) return "complex";

  if (recentMutateContext(history)) return "complex";

  if (containsAny(lower, SIMPLE_READ_KEYWORDS)) return "simple_read";

  return "unknown";
}

/**
 * Map a classified intent to a concrete model id. `simple_read` rides
 * grok-4-fast (~10× cheaper); everything else stays on the configured
 * GROK_CHAT_MODEL default (grok-4.3 in production).
 */
export function modelForIntent(intent: ChatIntent, defaultModel: string): string {
  if (intent === "simple_read") return process.env.GROK_FAST_MODEL ?? "grok-4-fast";
  return defaultModel;
}
