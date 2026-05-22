/**
 * Phase 9 — Langfuse tracing helper for WallE routes.
 *
 * Wraps `langfuse` v3 in a tiny no-op-on-missing-env facade so route handlers
 * stay clean. If LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are not present,
 * every method is a silent no-op (the route still works locally / in CI).
 *
 * Pattern (server-only, per request):
 *
 *   const trace = traceWalle({ name: "walle_chat", userId, sessionId });
 *   const gen = trace.generation({ name: "streamText", model, input: messages });
 *   // ...run LLM call...
 *   gen.end({ output: finalText, usage: { promptTokens, completionTokens } });
 *   await trace.flush(); // critical on serverless
 *
 * Notes:
 *  - We import dynamically so the lib isn't bundled when keys are absent.
 *  - All errors inside tracing are swallowed — observability must never break
 *    a real user request.
 */
import "server-only";

type LangfuseGeneration = {
  end: (args: {
    output?: unknown;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    metadata?: Record<string, unknown>;
    level?: "DEFAULT" | "ERROR" | "WARNING";
  }) => void;
};

type LangfuseTraceLike = {
  generation: (args: {
    name: string;
    model: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }) => LangfuseGeneration;
  flush: () => Promise<void>;
};

const NOOP_GENERATION: LangfuseGeneration = {
  end: () => {
    /* noop */
  },
};

const NOOP_TRACE: LangfuseTraceLike = {
  generation: () => NOOP_GENERATION,
  flush: async () => {
    /* noop */
  },
};

function hasKeys(): boolean {
  return Boolean(
    process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY,
  );
}

/**
 * Build a trace for one WallE request. Returns a no-op shim when Langfuse env
 * vars are missing so callers don't have to branch.
 */
export function traceWalle(opts: {
  name: "walle_chat" | "walle_joke" | "walle_compact";
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}): LangfuseTraceLike {
  if (!hasKeys()) return NOOP_TRACE;

  try {
    // Lazy require — only loaded when env keys exist.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Langfuse } = require("langfuse") as typeof import("langfuse");
    const langfuse = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_HOST,
    });

    const trace = langfuse.trace({
      name: opts.name,
      userId: opts.userId,
      sessionId: opts.sessionId,
      metadata: opts.metadata,
    });

    return {
      generation: (g) => {
        try {
          const generation = trace.generation({
            name: g.name,
            model: g.model,
            input: g.input,
            metadata: g.metadata,
          });
          return {
            end: (e) => {
              try {
                generation.end({
                  output: e.output,
                  usage: e.usage,
                  metadata: e.metadata,
                  level: e.level,
                });
              } catch {
                /* swallow */
              }
            },
          };
        } catch {
          return NOOP_GENERATION;
        }
      },
      flush: async () => {
        try {
          await langfuse.flushAsync();
        } catch {
          /* swallow */
        }
      },
    };
  } catch {
    return NOOP_TRACE;
  }
}
