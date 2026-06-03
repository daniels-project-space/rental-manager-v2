/**
 * Phase 4 — consolidated gate-predicate test for the REST write route in
 * hygglo-ui-action.ts.
 *
 * Proves the SINGLE truth-table that governs whether a live PATCH can be
 * routed via REST: ALL FIVE conditions must hold. The default posture (every
 * env flag UNSET) MUST be `false` — i.e. no REST write is reachable by default.
 *
 * `restWriteAllowed(action, allowHyggloSend)` is the in-process predicate; the
 * Convex `settings.ALLOW_HYGGLO_SEND` value is passed in as `allowHyggloSend`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { restWriteAllowed } from "./hygglo-ui-action";

const ACTION = "change_dates";
const FLAGS = [
  "USE_REST_WRITES",
  "READ_ONLY_MODE",
  "HYGGLO_UI_SHADOW_MODE",
  `HYGGLO_UI_LIVE_${ACTION.toUpperCase()}`,
] as const;

function clear() {
  for (const k of FLAGS) delete process.env[k];
}

/** Set the full happy-path: every gate open. */
function openAll() {
  process.env.USE_REST_WRITES = "true";
  delete process.env.READ_ONLY_MODE; // != 'true'
  process.env.HYGGLO_UI_SHADOW_MODE = "false";
  process.env[`HYGGLO_UI_LIVE_${ACTION.toUpperCase()}`] = "true";
}

afterEach(clear);

describe("restWriteAllowed — consolidated 5-gate predicate", () => {
  it("DEFAULT posture (all env unset, setting false) ⇒ false", () => {
    clear();
    expect(restWriteAllowed(ACTION, false)).toBe(false);
  });

  it("DEFAULT posture even with ALLOW_HYGGLO_SEND=true ⇒ false (shadow on, no USE_REST_WRITES)", () => {
    clear();
    expect(restWriteAllowed(ACTION, true)).toBe(false);
  });

  it("all five gates open ⇒ true", () => {
    openAll();
    expect(restWriteAllowed(ACTION, true)).toBe(true);
  });

  it("missing ALLOW_HYGGLO_SEND ⇒ false", () => {
    openAll();
    expect(restWriteAllowed(ACTION, false)).toBe(false);
  });

  it("USE_REST_WRITES unset ⇒ false", () => {
    openAll();
    delete process.env.USE_REST_WRITES;
    expect(restWriteAllowed(ACTION, true)).toBe(false);
  });

  it("READ_ONLY_MODE='true' ⇒ false", () => {
    openAll();
    process.env.READ_ONLY_MODE = "true";
    expect(restWriteAllowed(ACTION, true)).toBe(false);
  });

  it("HYGGLO_UI_SHADOW_MODE='true' (or unset ⇒ default true) ⇒ false", () => {
    openAll();
    process.env.HYGGLO_UI_SHADOW_MODE = "true";
    expect(restWriteAllowed(ACTION, true)).toBe(false);
    openAll();
    delete process.env.HYGGLO_UI_SHADOW_MODE; // default shadow ON
    expect(restWriteAllowed(ACTION, true)).toBe(false);
  });

  it("per-action live flag unset ⇒ false; a DIFFERENT action's flag does not unlock this one", () => {
    openAll();
    delete process.env[`HYGGLO_UI_LIVE_${ACTION.toUpperCase()}`];
    expect(restWriteAllowed(ACTION, true)).toBe(false);
    // Flag set for accept must NOT unlock change_dates.
    process.env.HYGGLO_UI_LIVE_ACCEPT = "true";
    expect(restWriteAllowed(ACTION, true)).toBe(false);
    delete process.env.HYGGLO_UI_LIVE_ACCEPT;
  });
});
