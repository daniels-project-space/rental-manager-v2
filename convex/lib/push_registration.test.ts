import { describe, expect, it } from "vitest";
import { ownsPushDestination, validatePushSubscription } from "./push_registration";
const phone = "https://web.push.apple.com/phone-subscription";
const desktop = "https://fcm.googleapis.com/desktop-subscription";
describe("persistent selected push destination", () => {
  it("blocks the live desktop heartbeat that was deleting the phone", () => {
    expect(ownsPushDestination({ endpoint: desktop }, phone)).toBe(false);
    expect(ownsPushDestination({ endpoint: phone }, phone)).toBe(true);
  });
  it("allows an intentional Enable gesture to move one destination", () => {
    expect(ownsPushDestination({ endpoint: phone, activate: true }, desktop)).toBe(true);
    expect(ownsPushDestination({ endpoint: desktop }, phone)).toBe(false);
  });
  it("renews the selected installation without admitting a different browser", () => {
    const renewed = `${phone}-renewed`;
    expect(ownsPushDestination({ endpoint: renewed, previous_endpoint: phone }, phone)).toBe(true);
    expect(ownsPushDestination({ endpoint: desktop, previous_endpoint: `${desktop}-old` }, phone)).toBe(false);
    expect(ownsPushDestination({ endpoint: phone, previous_endpoint: phone }, renewed)).toBe(false);
  });
  it("keeps ownership after the live subscription was pruned or a window closed", () => {
    // The persisted destination remains phone even with no deliverable row.
    expect(ownsPushDestination({ endpoint: desktop }, phone)).toBe(false);
    expect(ownsPushDestination({ endpoint: `${phone}-new`, previous_endpoint: phone }, phone)).toBe(true);
  });
  it("requires opt-in on an empty/explicitly disabled destination", () => {
    expect(ownsPushDestination({ endpoint: desktop }, null)).toBe(false);
    expect(ownsPushDestination({ endpoint: phone, previous_endpoint: phone }, null)).toBe(false);
    expect(ownsPushDestination({ endpoint: phone, activate: true }, null)).toBe(true);
  });
  it("rejects incomplete encryption keys before overwriting a working registration", () => {
    const p256dh = btoa(String.fromCharCode(4) + "x".repeat(64));
    const auth = btoa("x".repeat(16));
    expect(() => validatePushSubscription({ endpoint: phone, p256dh, auth })).not.toThrow();
    expect(() => validatePushSubscription({ endpoint: phone, p256dh: "", auth })).toThrow();
    expect(() => validatePushSubscription({ endpoint: phone, p256dh, auth: "" })).toThrow();
    expect(() => validatePushSubscription({ endpoint: "http://invalid.test", p256dh, auth })).toThrow();
  });
});
