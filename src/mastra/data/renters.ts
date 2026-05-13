/**
 * Renter profile + blacklist read surfaces.
 *
 * V1 mirror:
 *   - getProfile      → src/renter-profile/renter-profile.service.ts:447 buildRenterContext
 *   - checkBlacklist  → src/blacklist/blacklist.service.ts:57 isBlacklisted
 *
 * V2 backing queries: convex.renters.getByName, convex.renters.checkBlacklistByName
 * (both added in this Wave 2 PR — see convex/renters.ts).
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

/**
 * Returns full renter profile if found, else null in `data`.
 */
export async function getProfile(input: {
  name: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [profile, syncState] = await Promise.all([
      convex.query(anyApi.renters.getByName, { name: input.name }),
      getSyncState(),
    ]);
    return wrap({
      data: {
        ok: true as const,
        query: input.name,
        profile: profile ?? null,
        found: profile !== null,
      },
      source: "convex.renters.getByName",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * Returns `{ blacklisted: bool, ...details }`.
 */
export async function checkBlacklist(input: {
  name: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [result, syncState] = await Promise.all([
      convex.query(anyApi.renters.checkBlacklistByName, { name: input.name }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, query: input.name, ...(result as object) },
      source: "convex.renters.checkBlacklistByName",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
