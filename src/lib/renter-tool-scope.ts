import { AsyncLocalStorage } from "node:async_hooks";

export type RenterScope = { threadId: string; accountSlug: string; requestMessageId?: string; bookingWritesAllowed?: boolean; rentalStage?: string; queryRevision?:()=>number };
const storage = new AsyncLocalStorage<RenterScope>();
export const withRenterToolScope = <T>(scope: RenterScope, run: () => T): T => storage.run(scope, run);
export const currentRenterToolScope = () => storage.getStore();

/** The model chooses dates/items; server context owns thread and account. */
export function bindRenterToolArgs(functionName: string, args: Record<string, unknown>, scope = storage.getStore()) {
  if (!scope) return args;
  if (["renter_bot_lab_order:applyChange", "renter_bot_lab_order:applyAdditionBasket", "renter_bot_lab_order:applyReplacementBasket"].includes(functionName) && scope.bookingWritesAllowed === false) {
    throw new Error("Booking changes are disabled for this diagnostic candidate");
  }
  const bound = { ...args };
  if ("account_slug" in args || functionName === "renter_bot_tools:lookup_pricing") bound.account_slug = scope.accountSlug;
  if ("hygglo_order_id" in args) bound.hygglo_order_id = scope.threadId;
  if ("thread_id" in args || ["renter_bot_tools:check_availability","renter_bot_tools:check_basket_availability","renter_bot_tools:find_owned_alternatives"].includes(functionName)) bound.thread_id = scope.threadId;
  if (["renter_bot_lab_order:applyChange", "renter_bot_lab_order:applyAdditionBasket", "renter_bot_lab_order:applyReplacementBasket"].includes(functionName)) bound.request_message_id = scope.requestMessageId ?? "";
  return bound;
}
