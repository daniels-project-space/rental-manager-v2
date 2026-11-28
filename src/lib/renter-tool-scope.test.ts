import { describe, expect, it } from "vitest";
import { bindRenterToolArgs, withRenterToolScope } from "./renter-tool-scope";

describe("Lab renter tool scope", () => {
  it("binds alternative searches to the active Lab thread even when the model omits it", () => {
    const scope = {
      threadId: "__probe__session-2",
      accountSlug: "dbcinema",
      requestMessageId: "message-87654321",
    };
    const result = withRenterToolScope(scope, () => bindRenterToolArgs(
      "renter_bot_tools:find_owned_alternatives",
      { account_slug: "leo", booking_use: "standalone" },
    ));

    expect(result).toMatchObject({
      account_slug: "dbcinema",
      thread_id: "__probe__session-2",
      booking_use: "standalone",
    });
  });

  it("binds the current turn lease to simulated booking edits", () => {
    const scope = {
      threadId: "__probe__session-1",
      accountSlug: "diogo",
      requestMessageId: "message-12345678",
      labTurnId: "turn-12345678",
      labLeaseToken: "lease-12345678",
    };
    const result = withRenterToolScope(scope, () => bindRenterToolArgs(
      "renter_bot_lab_order:applyChange",
      { thread_id: "attacker-thread", request_message_id: "attacker-message", lab_turn_id: "attacker-turn" },
    ));
    expect(result).toMatchObject({
      thread_id: scope.threadId,
      request_message_id: scope.requestMessageId,
      lab_turn_id: scope.labTurnId,
      lab_lease_token: scope.labLeaseToken,
    });
  });
});
