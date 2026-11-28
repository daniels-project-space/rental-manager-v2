import { describe, expect, it } from "vitest";
import {
  hasCompleteRenterBotLabTurnBinding,
  renterBotLabTurnBindingMatches,
  type RenterBotLabMessageSnapshot,
  type RenterBotLabTurnBinding,
  type RenterBotLabTurnSnapshot,
} from "./renter_bot_lab_turn_binding";

const binding: RenterBotLabTurnBinding = {
  thread_id: "__probe__session-1",
  request_message_id: "__probe__session-1-turn-12345678",
  lab_turn_id: "turn-12345678",
  lab_lease_token: "lease-12345678",
};
const turn: RenterBotLabTurnSnapshot = {
  thread_id: binding.thread_id,
  account_slug: "diogo",
  renter_message_id: binding.request_message_id,
  renter_text: "Can I collect in Shoreditch?",
  lease_token: binding.lab_lease_token,
  status: "running",
};
const latest: RenterBotLabMessageSnapshot = {
  thread_id: binding.thread_id,
  account_slug: "diogo",
  message_id: binding.request_message_id,
  sender: "renter",
  body_text: turn.renter_text,
};

describe("Renter Bot Lab turn binding", () => {
  it("requires a complete isolated Lab turn capability", () => {
    expect(hasCompleteRenterBotLabTurnBinding(binding.thread_id, binding.request_message_id, binding.lab_turn_id, binding.lab_lease_token)).toBe(true);
    expect(hasCompleteRenterBotLabTurnBinding(binding.thread_id, binding.request_message_id, undefined, binding.lab_lease_token)).toBe(false);
    expect(hasCompleteRenterBotLabTurnBinding("real-thread", binding.request_message_id, binding.lab_turn_id, binding.lab_lease_token)).toBe(false);
  });

  it("accepts only the active lease for the latest exact renter message", () => {
    expect(renterBotLabTurnBindingMatches(binding, turn, latest)).toBe(true);
    expect(renterBotLabTurnBindingMatches(binding, { ...turn, lease_token: "old-lease-12345678" }, latest)).toBe(false);
    expect(renterBotLabTurnBindingMatches(binding, turn, { ...latest, sender: "owner" })).toBe(false);
    expect(renterBotLabTurnBindingMatches(binding, turn, { ...latest, thread_id: "__probe__other-thread" })).toBe(false);
    expect(renterBotLabTurnBindingMatches(binding, turn, { ...latest, body_text: "different message" })).toBe(false);
    expect(renterBotLabTurnBindingMatches(binding, turn, { ...latest, account_slug: "leo" })).toBe(false);
  });
});
