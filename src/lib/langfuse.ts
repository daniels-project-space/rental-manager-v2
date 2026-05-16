/**
 * Langfuse client — lazy singleton with graceful no-op fallback.
 *
 * Reads from env:
 *   LANGFUSE_PUBLIC_KEY  — required to enable real tracing
 *   LANGFUSE_SECRET_KEY  — required to enable real tracing
 *   LANGFUSE_HOST        — optional (default: https://cloud.langfuse.com)
 *
 * When either key is missing the module returns a no-op shim so that the app
 * runs normally in local/test environments where keys have not been provisioned.
 *
 * Env vars come from Vercel (synced from Convex vault under service "langfuse").
 * Do NOT inline credentials here.
 */

// ---------------------------------------------------------------------------
// Minimal span shape accepted by traceMastraSpan
// ---------------------------------------------------------------------------
export interface MastraSpan {
  name: string;
  traceId?: string;
  parentSpanId?: string;
  /** ISO-8601 start timestamp */
  startTime?: string;
  /** ISO-8601 end timestamp */
  endTime?: string;
  attributes?: Record<string, string | number | boolean>;
  status?: "ok" | "error" | "unset";
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared interface implemented by both real client and no-op shim
// ---------------------------------------------------------------------------
export interface LangfuseLike {
  readonly enabled: boolean;
  trace(params: {
    name: string;
    id?: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): {
    span(params: {
      name: string;
      startTime?: Date;
      endTime?: Date;
      metadata?: Record<string, unknown>;
      statusMessage?: string;
    }): void;
    update(params: Record<string, unknown>): void;
  };
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// No-op shim (returned when env keys are absent)
// ---------------------------------------------------------------------------
const noopTrace = () => ({
  span: () => undefined,
  update: () => undefined,
});

const noopShim: LangfuseLike = {
  enabled: false,
  trace: () => noopTrace(),
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Real client wrapper
// ---------------------------------------------------------------------------
let _instance: LangfuseLike | undefined;

function createRealClient(
  publicKey: string,
  secretKey: string,
  host: string,
): LangfuseLike {
  // Lazy-require to avoid loading the module when keys are absent
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Langfuse } = require("langfuse") as typeof import("langfuse");

  const client = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: host,
    // Flush quickly in serverless (Vercel functions complete fast)
    flushAt: 1,
    flushInterval: 0,
  });

  return {
    enabled: true,
    trace: (params) => {
      const t = client.trace({
        name: params.name,
        id: params.id,
        input: params.input as Record<string, unknown> | undefined,
        output: params.output as Record<string, unknown> | undefined,
        metadata: params.metadata,
        tags: params.tags,
      });
      return {
        span: (spanParams) =>
          void t.span({
            name: spanParams.name,
            startTime: spanParams.startTime,
            endTime: spanParams.endTime,
            metadata: spanParams.metadata,
            statusMessage: spanParams.statusMessage,
          }),
        update: (updateParams) => void t.update(updateParams),
      };
    },
    flush: () => client.flushAsync(),
    shutdown: () => client.shutdownAsync(),
  };
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------
export function getLangfuse(): LangfuseLike {
  if (_instance) return _instance;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host =
    process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    _instance = noopShim;
    return _instance;
  }

  try {
    _instance = createRealClient(publicKey, secretKey, host);
  } catch {
    // If the package fails to load for any reason, degrade gracefully
    _instance = noopShim;
  }

  return _instance;
}

// ---------------------------------------------------------------------------
// Helper: convert a Mastra/AI-SDK span into a Langfuse trace
// ---------------------------------------------------------------------------
export function traceMastraSpan(span: MastraSpan): void {
  const lf = getLangfuse();
  if (!lf.enabled) return;

  const startTime = span.startTime ? new Date(span.startTime) : undefined;
  const endTime = span.endTime ? new Date(span.endTime) : undefined;

  const t = lf.trace({
    name: span.name,
    id: span.traceId,
    metadata: {
      ...span.attributes,
      ...span.metadata,
      parentSpanId: span.parentSpanId,
      status: span.status ?? "unset",
    },
    tags: ["mastra"],
  });

  t.span({
    name: span.name,
    startTime,
    endTime,
    metadata: span.attributes as Record<string, unknown> | undefined,
    statusMessage: span.status,
  });
}

// ---------------------------------------------------------------------------
// Reset singleton (test helper — not exported in production interface)
// ---------------------------------------------------------------------------
export function _resetLangfuseSingleton(): void {
  _instance = undefined;
}
