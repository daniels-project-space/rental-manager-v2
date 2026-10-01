import { AsyncLocalStorage } from "node:async_hooks";

type RenterScope = { threadId: string; accountSlug: string };
const storage = new AsyncLocalStorage<RenterScope>();
export const withRenterToolScope = <T>(scope: RenterScope, run: () => T): T => storage.run(scope, run);

/** The model chooses dates/items; server context owns thread and account. */
export function bindRenterToolArgs(functionName: string, args: Record<string, unknown>, scope = storage.getStore()) {
  if (!scope) return args;
  const bound = { ...args };
  if ("account_slug" in args || functionName === "renter_bot_tools:lookup_pricing") bound.account_slug = scope.accountSlug;
  if ("thread_id" in args || functionName === "renter_bot_tools:check_availability") bound.thread_id = scope.threadId;
  return bound;
}
