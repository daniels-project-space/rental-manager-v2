import { describe, expect, it } from "vitest";
import {
  parseRenterBotLabSession,
  serializeRenterBotLabSession,
  type RenterBotLabSession,
} from "./renter-bot-lab-session";

const session: RenterBotLabSession = {
  threadId: "__probe__lab-1795728392677-abc123",
  accountSlug: "dbcinema",
  context: {
    scenarioTitle: "Blackmagic 6K Full Frame kit",
    itemName: "BMPCC 6K Full Frame",
    displayName: "BMPCC 6K Full Frame Kit",
    items: ["BMPCC 6K Full Frame"],
    startDate: "2026-12-10",
    endDate: "2026-12-10",
  },
};

describe("isolated Lab session persistence", () => {
  it("round-trips the active test chat and optional friend source", () => {
    const withFriend: RenterBotLabSession = {
      ...session,
      sourceThreadId: "__probe__lab-1795728392000-source",
      context: { ...session.context, friendReference: "friend-ref" },
    };
    expect(parseRenterBotLabSession(serializeRenterBotLabSession(withFriend))).toEqual(withFriend);
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-Lab thread", JSON.stringify({ ...session, threadId: "real-renter-thread" })],
    ["unknown account", JSON.stringify({ ...session, accountSlug: "other-account" })],
    ["incomplete display context", JSON.stringify({ ...session, context: { itemName: session.context.itemName } })],
    ["non-Lab friend source", JSON.stringify({ ...session, sourceThreadId: "real-renter-thread" })],
  ])("rejects %s", (_label, raw) => {
    expect(parseRenterBotLabSession(raw)).toBeNull();
  });
});
