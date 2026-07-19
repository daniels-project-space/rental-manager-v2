/**
 * Parity tests for hygglo-core/shape mappers against SAVED LIVE FIXTURES.
 *
 * Optional saved-live fixtures are wrapped in a probe
 * envelope `{ method, path, status, body }`; the real Hygglo payload is `.body`.
 *
 * These tests exercise the REAL mapping logic end-to-end on real Hygglo JSON —
 * no mocks of the unit under test, no tautologies. Each assertion pins a value
 * that can only be correct if the field-precedence + edge-case handling matches
 * poll-hygglo.ts (the parity target). Concrete expected values were read out of
 * the fixtures during the probe (order 3980371: same-day £35 / £22.40 GBP rental
 * for Kyriakos Athienitis, 18 chat msgs, active step RETURNED, no booking block
 * → photos fall back to items[].image.fullSizeUrl).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  orderToReservation,
  orderToRenter,
  orderToMessages,
  orderToConversation,
  orderToInquiryItems,
  deriveHyggloSystemSignal,
  parseCreatedAtLabel,
} from "../shape";
import type { HyggloOrderDetail } from "../types";
import { listProducts } from "../catalog";
import { getProduct } from "../catalog";
import type { HyggloClient } from "../client";

const FIXTURE_DIR =
  process.env.HYGGLO_PROBE_FIXTURE_DIR?.trim() ||
  resolve(process.cwd(), "test-fixtures/hygglo-probe");
const HAS_LIVE_FIXTURES = [
  "order_detail.json",
  "v2_my_products.json",
  "v2_product_detail.json",
].every((name) => existsSync(resolve(FIXTURE_DIR, name)));
const fixtureDescribe = HAS_LIVE_FIXTURES ? describe : describe.skip;
const fixtureIt = HAS_LIVE_FIXTURES ? it : it.skip;

/** Unwrap the probe envelope → real payload. */
function loadFixtureBody<T>(name: string): T {
  const raw = JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}.json`, "utf8"));
  return (raw && typeof raw === "object" && "body" in raw ? raw.body : raw) as T;
}

const orderDetail = HAS_LIVE_FIXTURES
  ? loadFixtureBody<HyggloOrderDetail>("order_detail")
  : ({} as HyggloOrderDetail);
const FETCHED_AT = 1_717_000_000_000; // fixed clock for deterministic assertions

fixtureDescribe("orderToReservation — parity with poll-hygglo shaping", () => {
  it("maps the core booking fields from real order 3980371", () => {
    const r = orderToReservation(orderDetail, "current", "stamp-1");
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.hygglo_order_id).toBe("3980371");
    expect(r.status).toBe("confirmed"); // sourceFilter=current → confirmed
    expect(r.start_date).toBe("2026-05-30");
    expect(r.end_date).toBe("2026-05-30");
    expect(r.currency).toBe("GBP");
    expect(r.gross_paid_gbp).toBe(35); // breakdown.totalPrice.amount
    expect(r.net_to_owner_gbp).toBe(22.4); // breakdown.lenderEarnings.amount
    expect(r.renter_name).toBe("Kyriakos Athienitis");
    expect(r.hygglo_user_id).toBe("13470822");
    expect(r.latest_activity).toBe("stamp-1");
    expect(r.order).toBe(orderDetail); // raw order forwarded verbatim
  });

  it("counts a same-day rental as 1 inclusive day (B1: Hygglo dates are inclusive)", () => {
    // Order 3980371 has start_date === end_date === "2026-05-30". Under the
    // corrected inclusive formula max(1, round(0)+1) this is a 1-day rental,
    // NOT 0/undefined (the old off-by-one money bug).
    const r = orderToReservation(orderDetail, "current");
    expect(r?.duration_days).toBe(1);
  });

  it("forwards exactly one PRODUCT item with fullSizeUrl image (INSURANCE filtered)", () => {
    const r = orderToReservation(orderDetail, "current");
    expect(r?.items).toHaveLength(1);
    const it = r!.items[0];
    expect(it.type).toBe("PRODUCT");
    expect(it.product_id).toBe(1112143);
    expect(it.item_name).toContain("RGB LED Light Panels");
    expect(it.image?.fullSizeUrl).toMatch(/^https:\/\/hygglo\.imgix\.net\//);
    expect(it.image?.thumbnailUrl).toMatch(/w=160/);
    // image fields the fixture lacks must be undefined (not invented):
    expect(it.image?.largeUrl).toBeUndefined();
    expect(it.image?.mediumUrl).toBeUndefined();
  });

  it("falls back to items[].image.fullSizeUrl for photos_urls when no booking block", () => {
    const r = orderToReservation(orderDetail, "current");
    expect(r?.photos_urls).toEqual([orderDetail.items![0].image!.fullSizeUrl]);
    // booking-derived fields are absent in this fixture:
    expect(r?.booking_status).toBeUndefined();
    expect(r?.pickup_time).toBeUndefined();
  });

  it("derives status from sourceFilter bucket", () => {
    expect(orderToReservation(orderDetail, "obsolete")?.status).toBe("cancelled");
    expect(orderToReservation(orderDetail, "pending")?.status).toBe(
      "pending_review",
    );
    expect(orderToReservation(orderDetail, "future")?.status).toBe("confirmed");
  });

  it("returns null when rentalPeriod dates are missing", () => {
    const noDates: HyggloOrderDetail = { ...orderDetail, rentalPeriod: {} };
    expect(orderToReservation(noDates, "current")).toBeNull();
  });
});

fixtureDescribe("orderToRenter / orderToMessages / orderToConversation", () => {
  it("preserves the exact listing product id for date-less inquiry pricing", () => {
    const inquiry = orderToInquiryItems({ ...orderDetail, rentalPeriod: {} });
    expect(inquiry.inquiry_items?.[0].product_id).toBe(1112143);
  });

  it("extracts the renter from users.otherPart", () => {
    expect(orderToRenter(orderDetail)).toEqual({
      hygglo_user_id: "13470822",
      display_name: "Kyriakos Athienitis",
    });
  });

  it("extracts only non-empty chat messages, tagging owner vs renter", () => {
    const msgs = orderToMessages(orderDetail, FETCHED_AT);
    // fixture has 18 chat activities (rest are system events)
    expect(msgs).toHaveLength(18);
    for (const m of msgs) {
      expect(m.thread_id).toBe("3980371");
      expect(m.body_text.trim().length).toBeGreaterThan(0);
      expect(["owner", "renter"]).toContain(m.sender);
      expect(m.sender_name).toBe(m.sender === "owner" ? "Owner" : "Kyriakos Athienitis");
      expect(m.fetched_at).toBe(FETCHED_AT);
    }
    // first chat in fixture is from the renter ("byMe": false)
    expect(msgs[0].sender).toBe("renter");
    expect(msgs[0].body_text).toBe("Kyriakos");
  });

  it("builds a conversation spec spanning the message timestamps", () => {
    const conv = orderToConversation(orderDetail, FETCHED_AT);
    expect(conv).not.toBeNull();
    if (!conv) return;
    expect(conv.thread_id).toBe("3980371");
    expect(conv.hygglo_user_id).toBe("13470822");
    expect(conv.display_name).toBe("Kyriakos Athienitis");
    expect(conv.last_msg_at).toBeGreaterThanOrEqual(conv.created_at);
  });

  it("returns null conversation for an order with no chat messages", () => {
    const noChat: HyggloOrderDetail = {
      ...orderDetail,
      activities: (orderDetail.activities ?? []).filter((a) => !a.chatMessage),
    };
    expect(orderToConversation(noChat, FETCHED_AT)).toBeNull();
    expect(orderToMessages(noChat, FETCHED_AT)).toHaveLength(0);
  });
});

describe("deriveHyggloSystemSignal (ported verbatim)", () => {
  fixtureIt("returns 'approved' for the fixture (carries a 'borrower should pay' event, no later obsolete)", () => {
    // order 3980371 is a paid active rental — the activities include the
    // approval event ("Now the borrower should pay") and NO decisive obsolete
    // event after it, so the ported reverse-scan resolves to 'approved'.
    // This pins parity with poll-hygglo.ts:deriveHyggloSystemSignal.
    const out = deriveHyggloSystemSignal(orderDetail.activities ?? []);
    expect(out.signal).toBe("approved");
    expect(out.text).toMatch(/should pay/i);
  });

  it("detects owner_denied from event content", () => {
    const out = deriveHyggloSystemSignal([
      { key: "e1", event: { content: "You have denied the rental request." } },
    ]);
    expect(out.signal).toBe("owner_denied");
  });

  it("prefers a later decisive obsolete event over an earlier approval", () => {
    // reverse-iteration: approval seen, then a renter_cancelled after it wins.
    const out = deriveHyggloSystemSignal([
      { key: "a", event: { content: "Now the borrower should pay" } },
      { key: "b", event: { content: "Kyriakos has cancelled the rental request" } },
    ]);
    expect(out.signal).toBe("renter_cancelled");
  });

  it("returns approved when only an approval event exists", () => {
    const out = deriveHyggloSystemSignal([
      { key: "a", event: { content: "Now the borrower should pay" } },
    ]);
    expect(out.signal).toBe("approved");
  });
});

describe("parseCreatedAtLabel (ported verbatim)", () => {
  it("parses 'DD Mon, HH:MM' labels (as in the fixture)", () => {
    const d = parseCreatedAtLabel("30 May, 14:58", new Date("2026-07-16T20:00:00Z"));
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-05-30T13:58:00.000Z"); // 14:58 BST
  });

  it("parses Today/Yesterday in Europe/London rather than server UTC", () => {
    const now = new Date("2026-07-16T20:30:00Z"); // 21:30 BST
    expect(parseCreatedAtLabel("Today 21:21", now)?.toISOString()).toBe(
      "2026-07-16T20:21:00.000Z",
    );
    expect(parseCreatedAtLabel("Yesterday 10:00", now)?.toISOString()).toBe(
      "2026-07-15T09:00:00.000Z",
    );
  });

  it("returns null for an empty / unparseable label", () => {
    expect(parseCreatedAtLabel("")).toBeNull();
    expect(parseCreatedAtLabel("some nonsense")).toBeNull();
  });
});

fixtureDescribe("catalog read mappers against real product fixtures", () => {
  it("listProducts returns the full account catalog (bare-array unwrap)", async () => {
    const products = loadFixtureBody<unknown[]>("v2_my_products");
    // Stub a client whose getJson returns the fixture page then an empty page,
    // exercising the real pagination/unwrap logic in listProducts.
    let call = 0;
    const client = {
      getJson: async () => (call++ === 0 ? products : []),
    } as unknown as HyggloClient;
    const out = await listProducts(client);
    expect(out.length).toBe(110);
    expect(out[0].id).toBe(1116299);
    expect(out[0].isPublished).toBe(true);
    expect(Array.isArray(out[0].prices)).toBe(true);
  });

  it("getProduct returns the detail payload with prices/images/listings", async () => {
    const detail = loadFixtureBody("v2_product_detail");
    const client = {
      getJson: async () => detail,
    } as unknown as HyggloClient;
    const out = await getProduct(client, 1116299);
    expect(out.id).toBe(1116299);
    expect(out.currency).toBe("GBP");
    expect(out.prices!.length).toBe(4);
    expect(out.images!.length).toBeGreaterThanOrEqual(1);
    expect(out.listings!.length).toBe(19);
    expect(out.publicUrl).toMatch(/^https:\/\/hygglo\.com\//);
  });
});
