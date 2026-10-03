import { AsyncLocalStorage } from "node:async_hooks";
import type { ConvexHttpClient } from "convex/browser";

export type ConvexClientFactory = () => ConvexHttpClient;
const storage = new AsyncLocalStorage<ConvexClientFactory>();

/** Tool calls get fresh clients with the same verified request identity. */
export const withConvexClientFactory = <T>(factory: ConvexClientFactory, run: () => T): T => storage.run(factory, run);
export function createRequestConvexClient(): ConvexHttpClient {
  const factory = storage.getStore();
  if (!factory) throw new Error("Missing server request Convex identity");
  return factory();
}
