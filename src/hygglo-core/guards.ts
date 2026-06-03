/**
 * hygglo-core/guards — Phase-gating trip-wires.
 *
 * Phase 1 is READ + SHAPE only. Every write function in orders.ts / catalog.ts
 * is fully TYPED (so callers compile against the final surface) but throws
 * `notEnabledYet()` at runtime — there is no code path that mutates Hygglo.
 *
 * `chatDisabled()` is the HARD rail for renter messaging: the send-message /
 * `chat` action is intentionally NEVER implemented. Its type exists; the
 * function throws permanently. This is a product/compliance constraint, not a
 * phase gate — it does NOT get removed in Phase 4.
 */

/** Writes (approve/decline/changeDates/changePrice/removeItem, catalog edits)
 *  land in Phase 4. Until then every write fn throws this. */
export function notEnabledYet(op: string): never {
  throw new Error(`hygglo-core: write "${op}" lands in Phase 4 — not enabled`);
}

/** Renter messaging is permanently disabled. The `chat` action must remain
 *  impossible — this throws regardless of phase. */
export function chatDisabled(): never {
  throw new Error(
    "hygglo-core: renter messaging (chat) is disabled and will not be implemented",
  );
}
