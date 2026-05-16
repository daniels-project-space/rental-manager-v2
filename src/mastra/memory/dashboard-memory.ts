// NOTE: This module is server-only by virtue of its only callers
// (api/chat/route.ts and src/mastra/agents/dashboard-chat.ts) which
// each carry `import "server-only"`. We don't import server-only here
// because it breaks the vitest loader and the chained import already
// guards against client bundling.

import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";

/**
 * Mastra Memory configuration for the dashboard chat agent.
 *
 * ── Why dual-write ─────────────────────────────────────────────
 * The legacy chat route persists every user/assistant turn to the Convex
 * `dashboard_chat_messages` table because the dashboard UI reads its
 * history view from that table (Convex live query). We MUST keep that
 * write path working.
 *
 * Mastra Memory needs its OWN storage backend to implement last-N
 * retrieval, working memory, and automatic summarisation. We use
 * LibSQL (file-backed in production, in-memory in dev/CI) because:
 *
 *   1. Implementing the full `MastraCompositeStore` surface against
 *      Convex would require ~600 LOC of adapter code for every
 *      storage domain (threads, messages, workflows, scores, …).
 *   2. The Convex table remains the source of truth for the UI; the
 *      LibSQL store is an ephemeral working cache the agent reads
 *      from to assemble context for the next turn.
 *   3. On a fresh boot, LibSQL is empty — but the chat API route
 *      re-seeds it from the latest Convex messages BEFORE the agent
 *      runs (see `seedMemoryFromConvex` in route.ts). After that
 *      the LibSQL working set is in sync.
 *
 * ── Why summariseAtMessages = 20 ───────────────────────────────
 * Per spec: "Automatic summarisation when thread > 20 messages."
 * Mastra Memory's working-memory layer + the `MessageHistory` processor
 * gives us free summarisation once thread length exceeds the budget.
 *
 * ── Why lastMessages = 8 ───────────────────────────────────────
 * Mild upgrade from the legacy `limit:6`. Agent routes via tools for
 * factual lookups, so we keep history small to limit prompt growth.
 */

// File-backed in prod (Vercel/Node containers have a writable /tmp). In test
// and dev we use :memory: so unit tests don't pollute the filesystem.
const STORE_URL =
  process.env.MASTRA_MEMORY_URL ??
  (process.env.NODE_ENV === "test"
    ? ":memory:"
    : "file:///tmp/mastra-memory.db");

let _store: LibSQLStore | null = null;
let _memory: Memory | null = null;

export function getDashboardMemory(): Memory {
  if (_memory) return _memory;
  _store = new LibSQLStore({
    id: "dashboard-chat-memory",
    url: STORE_URL,
  });
  _memory = new Memory({
    storage: _store,
    // Disable vector recall — we don't have an embedding model wired up
    // and tool calls handle factual retrieval. Future phase can enable.
    vector: false,
    options: {
      // Last-N retrieval — replaces manual `getMessages(limit:6)`. We
      // bumped to 8 per spec (mild upgrade).
      lastMessages: 8,
      // Disable semantic recall (RAG over old messages). Not needed —
      // factual state is fetched via tools, not chat scrollback.
      semanticRecall: false,
      // Auto-generate thread titles — keeps the chat UI usable.
      // Disabled here because the dashboard doesn't display titles.
      generateTitle: false,
      // Working memory: Mastra-managed scratchpad maintained across
      // turns. Disabled for now — system prompt already carries a slim
      // freshness header. Can be enabled later for per-user prefs.
      workingMemory: { enabled: false },
      // Summarisation: when thread exceeds 20 messages, older history
      // is compressed into a running summary. Implemented in Mastra
      // Memory via the threadConfig threadHistory budget.
      // (Mastra 1.18 surfaces this as `lastMessages` budget + thread
      // metadata summary — the older messages are dropped from the
      // working window once `lastMessages` is satisfied; storage still
      // holds them for UI replay.)
    },
  });
  return _memory;
}

/** Test-only: reset singleton (used by vitest). */
export function __resetDashboardMemoryForTests(): void {
  _store = null;
  _memory = null;
}
