import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@/lib/convex-request-context", () => ({
  createRequestConvexClient: () => ({ query: queryMock }),
}));

import { withRenterToolScope } from "@/lib/renter-tool-scope";
import { checkBasketAvailabilityTool, quoteBookingAdditionTool } from "./renter_bot_tools";

const baseProposal = {
  available: true,
  booking_use: "additional",
  preview_only: true,
  quote: { subtotal_gbp: 55, total_gbp: 55, lines: [] },
};

function executeCheck(threadId: string, bookingUse: "additional" | "proposed") {
  return withRenterToolScope({ threadId, accountSlug: "leo" }, () =>
    (checkBasketAvailabilityTool as unknown as { execute: (input: unknown) => Promise<any> }).execute({
      account_slug: "leo",
      thread_id: threadId,
      start_date: "2027-01-10",
      end_date: "2027-01-10",
      booking_use: bookingUse,
      items: [{ item_name: "DJI RS3 Pro gimbal", quantity: 1 }],
    }),
  );
}

function executeAdditionQuote(threadId: string) {
  return withRenterToolScope({ threadId, accountSlug: "dbcinema" }, () =>
    (quoteBookingAdditionTool as unknown as { execute: (input: unknown) => Promise<any> }).execute({
      thread_id: threadId,
      item_name: "BMPCC 6K Pro",
      qty: 1,
    }),
  );
}

describe("check_basket_availability Lab quote path", () => {
  beforeEach(() => queryMock.mockReset());

  it("carries an accepted travel adjustment into a read-only add-only inquiry quote", async () => {
    queryMock
      .mockResolvedValueOnce(baseProposal)
      .mockResolvedValueOnce({ travel_compensation_gbp: 5 });

    const result = await executeCheck("__probe__addition-discount", "additional");

    expect(result.quote).toMatchObject({ subtotal_gbp: 55, travel_compensation_gbp: 5, total_gbp: 50 });
    expect(result).toMatchObject({ preview_only: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("does not read or apply Lab discounts on a real conversation path", async () => {
    queryMock.mockResolvedValueOnce(baseProposal);

    const result = await executeCheck("real-thread-123", "additional");

    expect(result.quote).toEqual(baseProposal.quote);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a generic proposed quote when the Lab thread already has saved order items", async () => {
    queryMock.mockResolvedValueOnce({ items: [{ name: "BMPCC 6K Full Frame", qty: 1 }] });

    const result = await executeCheck("__probe__saved-order", "proposed");

    expect(result).toMatchObject({ ok: false, error_code: "existing_lab_order_requires_amendment_quote" });
    expect(result.error).toContain("quote_booking_dates");
    expect(result.error).toContain("quote_booking_amendment");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("quote_booking_addition listing selection", () => {
  beforeEach(() => queryMock.mockReset());

  it("preserves an ambiguous listing choice instead of collapsing it into a generic price failure", async () => {
    queryMock
      .mockResolvedValueOnce({ days: 1, account_slug: "dbcinema", start_date: "2026-12-12", end_date: "2026-12-12" })
      .mockResolvedValueOnce({
        found: false,
        selection_required: true,
        reason: "multiple_verified_listings",
        matched_canonical: "BMPCC 6K Pro",
        days: 1,
        quantity: 1,
        listing_options: [
          { product_id: 1048175, option_label: "Option 1", daily_rate_gbp: 35, source: "hygglo_tier" },
          { product_id: 954030, option_label: "Option 2", daily_rate_gbp: 47, source: "hygglo_listing" },
        ],
        message: "Ask which exact listing they want before quoting.",
      });

    const result = await executeAdditionQuote("__probe__ambiguous-listing");

    expect(result).toMatchObject({
      ok: false,
      selection_required: true,
      reason: "multiple_verified_listings",
      source: "verified_listing_choices",
      thread_id: "__probe__ambiguous-listing",
      account_slug: "dbcinema",
      matched_canonical: "BMPCC 6K Pro",
      days: 1,
      quantity: 1,
      start_date: "2026-12-12",
      end_date: "2026-12-12",
      listing_options: [
        { product_id: 1048175, option_label: "Option 1", daily_rate_gbp: 35, source: "hygglo_tier" },
        { product_id: 954030, option_label: "Option 2", daily_rate_gbp: 47, source: "hygglo_listing" },
      ],
      error: "Ask which exact listing they want before quoting.",
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
