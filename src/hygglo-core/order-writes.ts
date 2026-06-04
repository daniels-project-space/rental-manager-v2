/**
 * hygglo-core/order-writes — GATED, DRY-RUN-FIRST core order-write entry point.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SAFETY POSTURE (read before touching):
 *
 *  Order writes to Hygglo are IRREVERSIBLE. This module is the ONLY thing that
 *  makes `hygglo-core/orders.ts`'s write surface (approve/decline/changeDates/
 *  changePrice/removeItem) reachable from the live action path — so it is built
 *  GATED and DRY-RUN-FIRST and defaults to taking NO action:
 *
 *    1. FEATURE GATE   `USE_CORE_ORDER_WRITES` env, DEFAULT OFF. When unset the
 *                      live path never reaches this module (the dispatcher in
 *                      hygglo-ui-action.ts checks `useCoreOrderWrites()` first
 *                      and falls through to the existing legacy REST/browser
 *                      route). No DB feature_flags row is created.
 *
 *    2. DRY-RUN MODE   `CORE_ORDER_WRITES_DRY_RUN` env, DEFAULT ON. When ON
 *                      (the default, AND whenever the var is unset) this module
 *                      RESOLVES + RETURNS the intended action payload and makes
 *                      ZERO network calls — it never invokes `orders.*`, so no
 *                      fetch is constructed. A REAL write happens ONLY when the
 *                      gate is ON *and* `CORE_ORDER_WRITES_DRY_RUN === "false"`
 *                      — a state that is intentionally NEVER set anywhere in
 *                      the repo, CI, or prod env.
 *
 *    3. CHOKEPOINT     Even in the (never-set) live state, the real write still
 *                      flows through `orders.*` → `src/lib/hygglo-write.ts`,
 *                      which re-checks `READ_ONLY_MODE` on every call. So a live
 *                      write requires ALL of: gate ON + dryRun false +
 *                      READ_ONLY_MODE!=='true' + the hygglo-ui-action consolidated
 *                      5-gate predicate. Defence in depth — no single flag arms it.
 *
 *  The `chat`/sendMessage action is INTENTIONALLY ABSENT — renter messaging
 *  stays impossible (guards.chatDisabled).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createHyggloCore } from "./index";
import type { HyggloWriteResult } from "./types";

/** UI-action names this core route can map onto `hygglo-core/orders.ts`. */
export type CoreOrderAction =
  | "accept"
  | "decline"
  | "change_dates"
  | "apply_discount"
  | "change_owner_earnings"
  | "remove_item";

const CORE_ROUTABLE: ReadonlySet<string> = new Set<CoreOrderAction>([
  "accept",
  "decline",
  "change_dates",
  "apply_discount",
  "change_owner_earnings",
  "remove_item",
]);

/**
 * The intended Hygglo write, resolved but (in dry-run) NOT executed. Mirrors the
 * `{ action: <verb>, data: <payload> }` action-dispatcher body that
 * hygglo-write.ts would PATCH, so a dry-run is a faithful preview.
 */
export interface CoreOrderWritePlan {
  /** UI-action name as received from the dispatcher. */
  uiAction: CoreOrderAction;
  /** Hygglo wire verb the eventual PATCH would carry (owned by hygglo-write.ts). */
  wireVerb: "approve" | "decline" | "selectDates" | "changePrice" | "removeItem";
  /** Account vault slug the write targets. */
  accountSlug: string;
  /** Hygglo order id the write targets. */
  hyggloOrderId: string;
  /** The `data` payload the dispatcher body would carry. */
  data: Record<string, unknown>;
}

export type CoreOrderWriteOutcome =
  | {
      /** Gate/dry-run short-circuit: the intended write, NOT executed. */
      mode: "dry_run";
      executed: false;
      plan: CoreOrderWritePlan;
    }
  | {
      /** A real write was attempted via orders.* → hygglo-write.ts. */
      mode: "live";
      executed: true;
      plan: CoreOrderWritePlan;
      result: HyggloWriteResult;
    };

// ── Env gates (mirror the USE_REST_WRITES env-flag pattern) ─────────────────

/** Feature gate. DEFAULT OFF — only `"true"` (case-insensitive) enables. */
export function useCoreOrderWrites(): boolean {
  return (process.env.USE_CORE_ORDER_WRITES ?? "").toLowerCase() === "true";
}

/**
 * Dry-run resolver. DEFAULT ON. A real write is permitted ONLY when the var is
 * the explicit literal `"false"`. Unset, empty, or anything-but-"false" ⇒ ON.
 * This is the irreversible-write trip-wire; do NOT loosen it.
 */
export function coreOrderWritesDryRun(): boolean {
  return (process.env.CORE_ORDER_WRITES_DRY_RUN ?? "true").toLowerCase() !== "false";
}

/** True only for the action names this route knows how to map. */
export function isCoreRoutableAction(action: string): action is CoreOrderAction {
  return CORE_ROUTABLE.has(action);
}

// ── Plan builder (pure — no network, no orders.* call) ──────────────────────

/**
 * Resolve a UI action + args into the intended Hygglo write plan WITHOUT
 * executing it. Pure: throws on a missing required field so a dry-run surfaces
 * shape bugs before they ever reach a live PATCH. Returns `null` for unmapped
 * actions (caller falls through to the legacy route).
 */
export function planCoreOrderWrite(args: {
  accountSlug: string;
  action: string;
  orderId?: string;
  actionArgs: Record<string, unknown>;
}): CoreOrderWritePlan | null {
  const { accountSlug, action, orderId, actionArgs } = args;
  if (!isCoreRoutableAction(action)) return null;
  if (!orderId) {
    throw new Error(`core order write "${action}": missing orderId`);
  }
  switch (action) {
    case "accept":
      return { uiAction: action, wireVerb: "approve", accountSlug, hyggloOrderId: orderId, data: {} };
    case "decline":
      return {
        uiAction: action,
        wireVerb: "decline",
        accountSlug,
        hyggloOrderId: orderId,
        data: { reason: typeof actionArgs.reason === "string" ? actionArgs.reason : "" },
      };
    case "change_dates": {
      const rentalStartDate = String(actionArgs.rentalStartDate ?? actionArgs.startDate ?? "");
      const rentalEndDate = String(actionArgs.rentalEndDate ?? actionArgs.endDate ?? "");
      return {
        uiAction: action,
        wireVerb: "selectDates",
        accountSlug,
        hyggloOrderId: orderId,
        data: { rentalStartDate, rentalEndDate },
      };
    }
    case "apply_discount":
    case "change_owner_earnings": {
      const price = Number(actionArgs.price ?? actionArgs.amount);
      return {
        uiAction: action,
        wireVerb: "changePrice",
        accountSlug,
        hyggloOrderId: orderId,
        data: { price },
      };
    }
    case "remove_item": {
      const itemId = Number(actionArgs.itemId);
      return {
        uiAction: action,
        wireVerb: "removeItem",
        accountSlug,
        hyggloOrderId: orderId,
        data: { itemId },
      };
    }
  }
}

// ── Executor (dry-run-first; live path delegates to orders.* → hygglo-write) ─

/**
 * Gated, dry-run-first core order-write entry point. Makes
 * `hygglo-core/orders.ts` reachable from the live action path WITHOUT changing
 * default behaviour:
 *
 *   - `null`              ⇒ action is not core-routable; caller uses legacy route.
 *   - `{ mode:"dry_run" }`⇒ DEFAULT. Intended payload returned, NO network call,
 *                           `orders.*` NEVER invoked, no fetch constructed.
 *   - `{ mode:"live" }`   ⇒ ONLY when `dryRun === false` (never set). Invokes
 *                           the matching `orders.*` fn, which delegates to
 *                           hygglo-write.ts (which re-checks READ_ONLY_MODE).
 *
 * `dryRun` defaults to `coreOrderWritesDryRun()` (ON). Callers SHOULD NOT pass
 * an explicit `false`; tests do so only to assert the wiring, with the network
 * layer mocked.
 */
export async function coreOrderWrite(args: {
  accountSlug: string;
  action: string;
  orderId?: string;
  actionArgs?: Record<string, unknown>;
  /** Override resolver. DEFAULT = env-resolved dry-run (ON). */
  dryRun?: boolean;
}): Promise<CoreOrderWriteOutcome | null> {
  const plan = planCoreOrderWrite({
    accountSlug: args.accountSlug,
    action: args.action,
    orderId: args.orderId,
    actionArgs: args.actionArgs ?? {},
  });
  if (!plan) return null;

  const dryRun = args.dryRun ?? coreOrderWritesDryRun();
  if (dryRun) {
    // DRY RUN (default): return the intended write. orders.* is NOT called, so
    // no fetch is constructed and no Hygglo endpoint is touched.
    return { mode: "dry_run", executed: false, plan };
  }

  // LIVE (only when dryRun === false — never set in repo/CI/prod). Delegates to
  // the orders.* surface, which forwards to hygglo-write.ts (READ_ONLY_MODE
  // re-checked there). This is the single line that can ever execute a write.
  const core = createHyggloCore(plan.accountSlug);
  const result = await dispatchToOrders(core.orders, core.client, plan);
  return { mode: "live", executed: true, plan, result };
}

/** Map a resolved plan onto the matching `hygglo-core/orders.ts` write fn. */
async function dispatchToOrders(
  orders: typeof import("./orders"),
  client: import("./client").HyggloClient,
  plan: CoreOrderWritePlan,
): Promise<HyggloWriteResult> {
  const id = plan.hyggloOrderId;
  switch (plan.uiAction) {
    case "accept":
      return orders.approve(client, id);
    case "decline":
      return orders.decline(client, id, { reason: String(plan.data.reason ?? "") });
    case "change_dates":
      return orders.changeDates(client, id, {
        rentalStartDate: String(plan.data.rentalStartDate ?? ""),
        rentalEndDate: String(plan.data.rentalEndDate ?? ""),
      });
    case "apply_discount":
    case "change_owner_earnings":
      return orders.changePrice(client, id, { price: Number(plan.data.price) });
    case "remove_item":
      return orders.removeItem(client, id, { itemId: Number(plan.data.itemId) });
  }
}
