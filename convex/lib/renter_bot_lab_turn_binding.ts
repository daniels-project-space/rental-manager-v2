export type RenterBotLabTurnBinding = {
  thread_id: string;
  request_message_id: string;
  lab_turn_id: string;
  lab_lease_token: string;
};

export type RenterBotLabTurnSnapshot = {
  thread_id: string;
  account_slug: string;
  renter_message_id: string;
  renter_text: string;
  lease_token: string;
  status: string;
};

export type RenterBotLabMessageSnapshot = {
  thread_id: string;
  account_slug: string;
  message_id: string;
  sender: string;
  body_text: string;
};

export function hasCompleteRenterBotLabTurnBinding(
  threadId: unknown,
  requestMessageId: unknown,
  turnId: unknown,
  leaseToken: unknown,
): threadId is string {
  return typeof threadId === "string" && threadId.startsWith("__probe__") &&
    typeof requestMessageId === "string" && requestMessageId.trim().length > 0 &&
    typeof turnId === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(turnId) &&
    typeof leaseToken === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(leaseToken);
}

/** Ensure a generated reply still owns the exact current renter turn. */
export function renterBotLabTurnBindingMatches(
  binding: RenterBotLabTurnBinding,
  turn: RenterBotLabTurnSnapshot | null | undefined,
  latest: RenterBotLabMessageSnapshot | null | undefined,
): boolean {
  return hasCompleteRenterBotLabTurnBinding(
    binding.thread_id,
    binding.request_message_id,
    binding.lab_turn_id,
    binding.lab_lease_token,
  ) && Boolean(turn && latest &&
    turn.status === "running" &&
    turn.thread_id === binding.thread_id &&
    turn.renter_message_id === binding.request_message_id &&
    turn.lease_token === binding.lab_lease_token &&
    turn.renter_text === latest.body_text &&
    latest.thread_id === binding.thread_id &&
    latest.message_id === binding.request_message_id &&
    latest.sender === "renter" &&
    latest.account_slug === turn.account_slug);
}
