import { query as rawQuery, mutation as rawMutation, action as rawAction, internalQuery as rawInternalQuery, internalMutation as rawInternalMutation, internalAction as rawInternalAction } from "./_generated/server";
import type { DefaultFunctionArgs, RegisteredQuery, RegisteredMutation, RegisteredAction } from "convex/server";
import { internal } from "./_generated/api";
import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { authorizeOwner, ownerEnforcementRequired } from "./lib/owner_authorization";

export * from "./_generated/server";

export async function requireOwner(ctx: GenericCtx<DataModel>, enforce = false) {
  if (!enforce && !ownerEnforcementRequired(process.env.OWNER_AUTH_REQUIRED)) return;
  await authorizeOwner(
    await ctx.auth.getUserIdentity(),
    process.env.CONVEX_SITE_URL,
    () => "db" in ctx ? ctx.db.query("owner_access").first() : ctx.runQuery(internal.owner_access.get, {}),
    () => authComponent.safeGetAuthUser(ctx),
  );
}

// Preserve each SDK builder's complete type signature and validator behavior.
// Internal builders remain unchanged; only publicly callable registrations wrap.
type FunctionKind = "query" | "mutation" | "action";
const definitions = new WeakMap<object, { kind: FunctionKind; definition: any }>();

function protect<Builder>(builder: Builder, kind: FunctionKind): Builder {
  return ((definition: any) => {
    const original = typeof definition === "function" ? definition : definition.handler;
    const handler = async (ctx: GenericCtx<DataModel>, args: unknown) => {
      await requireOwner(ctx);
      return original(ctx, args);
    };
    const registered = (builder as any)(typeof definition === "function" ? handler : { ...definition, handler });
    definitions.set(registered, { kind, definition });
    return registered;
  }) as Builder;
}

export const query = protect(rawQuery, "query");
export const mutation = protect(rawMutation, "mutation");
export const action = protect(rawAction, "action");

function originalDefinition(registered: object, kind: FunctionKind) {
  const original = definitions.get(registered);
  if (!original || original.kind !== kind) throw new Error("Internal counterpart requires a matching owner-protected registration");
  return original.definition;
}

/** Same original handler/validators; Convex's internal transport controls access. */
export function internalQueryOf<Args extends DefaultFunctionArgs, Returns>(registered: RegisteredQuery<"public", Args, Returns>): RegisteredQuery<"internal", Args, Returns> {
  return rawInternalQuery(originalDefinition(registered, "query")) as RegisteredQuery<"internal", Args, Returns>;
}
export function internalMutationOf<Args extends DefaultFunctionArgs, Returns>(registered: RegisteredMutation<"public", Args, Returns>): RegisteredMutation<"internal", Args, Returns> {
  return rawInternalMutation(originalDefinition(registered, "mutation")) as RegisteredMutation<"internal", Args, Returns>;
}
export function internalActionOf<Args extends DefaultFunctionArgs, Returns>(registered: RegisteredAction<"public", Args, Returns>): RegisteredAction<"internal", Args, Returns> {
  return rawInternalAction(originalDefinition(registered, "action")) as RegisteredAction<"internal", Args, Returns>;
}
