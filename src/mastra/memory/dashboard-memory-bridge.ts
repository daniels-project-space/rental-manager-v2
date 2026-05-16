// NOTE: server-only enforcement comes from the caller (api/chat/route.ts);
// see dashboard-memory.ts for the rationale.

import { getDashboardMemory } from "./dashboard-memory";

/**
 * Seed Mastra Memory's LibSQL store with the most recent Convex chat
 * messages for a thread. This is necessary because:
 *
 *   1. Convex `dashboard_chat_messages` is the UI source of truth.
 *   2. Mastra Memory uses a separate (ephemeral) LibSQL store for
 *      retrieval/summarisation.
 *   3. On a fresh Vercel/Node container boot, LibSQL is empty — so
 *      the very first agent call would lose all prior context.
 *
 * To bridge: at the start of every chat turn, we ensure the thread's
 * recent messages exist in Memory storage. We do this idempotently —
 * if a message with the same content+role+timestamp is already in
 * Memory, we skip it.
 *
 * This adds at most ~20 message writes per turn (typically 0 once a
 * thread is warm). Keeps the spec promise that "chat UI history view
 * MUST keep working" while still using Mastra Memory for the agent's
 * own context window.
 */
export type ConvexMessageRow = {
  _id: string;
  thread_id?: string;
  role: string;
  content: string;
  metadata?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  created_at?: number;
};

let _seededThreads = new Set<string>();

/** Test-only: reset the warm-thread set. */
export function __resetSeedTrackerForTests(): void {
  _seededThreads = new Set();
}

export async function seedMemoryFromConvex(
  thread_id: string,
  resource_id: string,
  messages: ConvexMessageRow[],
): Promise<void> {
  const seedKey = `${resource_id}::${thread_id}`;
  // Only seed once per process lifetime per thread — subsequent turns
  // accrete via Memory's own save path.
  if (_seededThreads.has(seedKey)) return;

  const memory = getDashboardMemory();
  try {
    // Ensure the thread exists in Mastra Memory storage.
    await memory.saveThread({
      thread: {
        id: thread_id,
        resourceId: resource_id,
        title: thread_id,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (messages.length === 0) {
      _seededThreads.add(seedKey);
      return;
    }
    // Build CoreMessage rows. We only seed user/assistant — system/error
    // messages are surfaced to the UI but not relevant to the LLM
    // context window.
    const toSave = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        id: m._id,
        threadId: thread_id,
        resourceId: resource_id,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: new Date(m.created_at ?? Date.now()),
        type: "text" as const,
      }));
    if (toSave.length > 0) {
      // saveMessages is best-effort: dupes throw (PK collision), which
      // we swallow because the goal is "ensure present".
      await memory
        // Cast: the public `saveMessages` typing on Memory uses an
        // internal `MastraDBMessage`; CoreMessage shape above is the
        // public-friendly subset that the underlying storage accepts.
        // Any mismatch is caught at runtime by the storage layer.
        .saveMessages({ messages: toSave as never, format: "v2" } as never)
        .catch((err: unknown) => {
          // Idempotent seed — duplicate PKs are expected on warm boots.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/duplicate|unique|already exists/i.test(msg)) {
            console.warn("[memory-bridge] seed failed (non-dup):", msg);
          }
        });
    }
    _seededThreads.add(seedKey);
  } catch (err) {
    // Seeding failure must NOT break chat — fall through. The agent
    // will just lack history on this turn.
    console.warn(
      "[memory-bridge] seedMemoryFromConvex failed for",
      seedKey,
      err,
    );
  }
}
