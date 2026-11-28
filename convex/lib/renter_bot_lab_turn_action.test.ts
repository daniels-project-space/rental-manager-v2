import { describe, expect, it } from "vitest";
import { parseReferralRestoreTurnKey, referralRestoreTurnKey, verifiedReferralRestoreReplay } from "./renter_bot_lab_turn_action";

describe("friend referral restore turn receipt", () => {
  const action = {
    request_message_id: "friend-inbound",
    referral_code: "a762acfe-9493-4c7f-ae52-fcb8ac61e2ae",
    start_date: "2099-10-08",
    end_date: "2099-10-09",
    items: [{ product_id: 7, qty: 1 }, { product_id: 3, qty: 2 }],
  };

  it("round-trips a canonical action and binds it to the exact renter message", () => {
    const key = referralRestoreTurnKey(action);
    expect(parseReferralRestoreTurnKey(key, "friend-inbound")).toEqual({
      ...action,
      items: [{ product_id: 3, qty: 2 }, { product_id: 7, qty: 1 }],
    });
    expect(parseReferralRestoreTurnKey(key, "another-message")).toBeNull();
    expect(parseReferralRestoreTurnKey(key, "")).toBeNull();
  });

  it("rejects malformed or ambiguous action keys", () => {
    const valid = JSON.parse(referralRestoreTurnKey(action)) as unknown[];
    for (const invalid of [
      null,
      "not-json",
      JSON.stringify([...valid.slice(0, 5), [{ product_id: 3, qty: 1 }, { product_id: 3, qty: 1 }]]),
      JSON.stringify([...valid.slice(0, 5), [{ product_id: 3, qty: 0 }]]),
      JSON.stringify(["other", ...valid.slice(1)]),
    ]) expect(parseReferralRestoreTurnKey(invalid, "friend-inbound")).toBeNull();
  });

  it("returns a replay proof only while the exact same-turn restored order remains current", () => {
    const input = {
      change_key: referralRestoreTurnKey(action), request_message_id: "friend-inbound", latest_renter_message_id: "friend-inbound",
      thread_id: "__probe__friend", account_slug: "leo", start_date: action.start_date, end_date: action.end_date,
      order_items: [{ product_id: 3, qty: 2 }, { product_id: 7, qty: 1 }],
      redeemed_by: "__probe__friend", referral_account_slug: "leo",
    };
    expect(verifiedReferralRestoreReplay(input)).toEqual({
      source: "native_lab_amendment", action: "restore_referral_basket", thread_id: "__probe__friend", account_slug: "leo",
      request_message_id: "friend-inbound", start_date: action.start_date, end_date: action.end_date,
      items: [{ product_id: 3, qty: 2 }, { product_id: 7, qty: 1 }],
    });
    for (const changed of [
      { latest_renter_message_id: "new-message" },
      { thread_id: "real-thread" },
      { account_slug: "dbcinema" },
      { start_date: "2099-10-10" },
      { order_items: [{ product_id: 3, qty: 1 }] },
      { redeemed_by: "another-thread" },
      { referral_account_slug: "dbcinema" },
    ]) expect(verifiedReferralRestoreReplay({ ...input, ...changed })).toBeNull();
  });
});
