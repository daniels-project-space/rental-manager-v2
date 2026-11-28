import { describe, expect, it } from "vitest";
import { buildListingSourceReceipts, buildOwnerVerifiedPickupAvailability, buildPickupFactReceipts, currentPickupAvailability, pickupAreaFallback, pickupAvailabilityAppliesToRental, verifiedPickupReasonForSingleListing } from "./renter_bot_listing_pickup";

describe("currentPickupAvailability", () => {
  const now = Date.UTC(2026, 10, 26);

  it("accepts a current owner-verified account-area policy without inventing a temporary reason", () => {
    expect(currentPickupAvailability({
      status: "account_area_only",
      source: "owner-confirmed pickup area",
      verified_at: now,
    }, now)).toEqual({
      status: "account_area_only",
      source: "owner-confirmed pickup area",
      verified_at: now,
    });
    expect(pickupAreaFallback("Northumberland Street")).toBe(
      "For this rental, collection and return are arranged from the Northumberland Street area. Would collecting and returning there work for your dates?",
    );
  });

  it("uses a temporary reason only while its owner-verified expiry is current", () => {
    const fact = {
      status: "currently_on_rental",
      customer_explanation: "This item is out on another rental until Friday.",
      source: "owner-confirmed rental schedule",
      verified_at: now - 60_000,
      valid_until: now + 60_000,
      applies_start_date: "2026-11-27",
      applies_end_date: "2026-11-29",
    };
    const current = currentPickupAvailability(fact, now);
    expect(current?.customer_explanation).toBe(fact.customer_explanation);
    expect(pickupAvailabilityAppliesToRental(current!, "2026-11-27", "2026-11-29")).toBe(true);
    expect(pickupAvailabilityAppliesToRental(current!, "2026-11-26", "2026-11-29")).toBe(false);
    expect(pickupAvailabilityAppliesToRental(current!, null, "2026-11-29")).toBe(false);
    expect(currentPickupAvailability(fact, now + 60_000)).toBeNull();
  });

  it("builds traceable owner facts and validates transient reason provenance, dates, and expiry", () => {
    const fact = buildOwnerVerifiedPickupAvailability({
      status: "assigned_to_set",
      customer_explanation: "This kit is assigned to a production set.",
      source: "Production schedule row 42",
      source_url: "https://example.com/schedule/42",
      applies_start_date: "2026-11-27",
      applies_end_date: "2026-11-29",
      valid_until: now + 24 * 60 * 60 * 1000,
    }, now);
    expect(fact).toMatchObject({
      status: "assigned_to_set",
      source: "Production schedule row 42",
      verified_at: now,
    });
    expect(currentPickupAvailability(fact, now)?.status).toBe("assigned_to_set");
    expect(buildOwnerVerifiedPickupAvailability({ status: "account_area_only", source: "Owner-confirmed pickup policy" }, now))
      .toEqual({ status: "account_area_only", source: "Owner-confirmed pickup policy", verified_at: now });
    expect(() => buildOwnerVerifiedPickupAvailability({ status: "currently_on_rental", source: "schedule" }, now)).toThrow("renter-facing explanation");
    expect(() => buildOwnerVerifiedPickupAvailability({ status: "in_repair", source: "repair log", customer_explanation: "In repair", applies_start_date: "2026-11-29", applies_end_date: "2026-11-27", valid_until: now + 1000 }, now)).toThrow("date range");
    expect(() => buildOwnerVerifiedPickupAvailability({ status: "currently_on_rental", source: "schedule", customer_explanation: "On rental", applies_start_date: "2026-11-27", applies_end_date: "2026-11-29", valid_until: now + 15 * 24 * 60 * 60 * 1000 }, now)).toThrow("expire within 14 days");
    expect(() => buildOwnerVerifiedPickupAvailability({ status: "in_repair", source: "repair log", source_url: "javascript:alert(1)", customer_explanation: "In repair", applies_start_date: "2026-11-27", applies_end_date: "2026-11-29", valid_until: now + 1000 }, now)).toThrow("HTTP(S) URL");
  });

  it("rejects unverified, stale, incomplete, and malformed transient reasons", () => {
    expect(currentPickupAvailability({ status: "in_repair", customer_explanation: "In repair", verified_at: now, source: "owner" }, now)).toBeNull();
    expect(currentPickupAvailability({ status: "in_repair", customer_explanation: "In repair", verified_at: now, source: "owner", valid_until: now + 60_000, applies_start_date: "2026-11-29", applies_end_date: "2026-11-27" }, now)).toBeNull();
    expect(currentPickupAvailability({ status: "in_repair", customer_explanation: "In repair", verified_at: now, source: "owner", valid_until: now + 60_000 }, now + 15 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(currentPickupAvailability({ status: "made_up", source: "owner", verified_at: now }, now)).toBeNull();
  });
});

describe("listing and pickup evidence receipts", () => {
  const now = Date.UTC(2026, 10, 26);
  const item = {
    account_slug: "diogo",
    product_id: 123,
    name: "BMPCC 6K Pro",
    listing_name: "BMPCC 6K Pro kit",
    listing_source: "hygglo_products",
    public_url: "https://example.test/listing/123",
    listing_synced_at: now - 1000,
    listing_description_synced_at: now - 2000,
    listing_description_source: "online_listings",
    listing_description_updated_at: now - 2500,
    inventory_name: "Blackmagic Pocket Cinema Camera 6K Pro",
    inventory_updated_at: now - 3000,
    mapping_complete: true,
    kit_source: "physical_inventory_mapping",
    inventory_components: [{ name: "NP-F570 battery", requested_units: 5, source_updated_at: now - 4000 }],
    pickup_availability: {
      status: "currently_on_rental",
      customer_explanation: "This kit is already booked for collection in Shoreditch.",
      source: "owner-confirmed rental schedule",
      verified_at: now,
      valid_until: now + 60_000,
      applies_start_date: "2026-11-27",
      applies_end_date: "2026-11-29",
    },
  };

  it("preserves exact listing identity and freshness while dropping malformed source fields", () => {
    expect(buildListingSourceReceipts([item], "diogo", now)).toEqual([{
      account_slug: "diogo",
      product_id: 123,
      listing_name: "BMPCC 6K Pro kit",
      checked_at: now,
      listing_source: "hygglo_products",
      public_url: "https://example.test/listing/123",
      listing_synced_at: now - 1000,
      listing_description_synced_at: now - 2000,
      listing_description_source: "online_listings",
      listing_description_updated_at: now - 2500,
      inventory_name: "Blackmagic Pocket Cinema Camera 6K Pro",
      inventory_updated_at: now - 3000,
      mapping_complete: true,
      kit_source: "physical_inventory_mapping",
      inventory_components: [{ name: "NP-F570 battery", requested_units: 5, source_updated_at: now - 4000 }],
    }]);
    expect(buildListingSourceReceipts([item], "leo", now)).toEqual([]);
  });

  it("persists contents only alongside their provenance and recorded time", () => {
    const sourceBacked = buildListingSourceReceipts([{
      ...item,
      included_with_rental: ["1× 2TB SSD"],
      included_with_rental_source: "owner-confirmed kit contents",
      included_with_rental_recorded_at: now - 500,
    }], "diogo", now);
    expect(sourceBacked[0]).toMatchObject({
      kit_contents: ["1× 2TB SSD"],
      kit_contents_source: "owner-confirmed kit contents",
      kit_contents_recorded_at: now - 500,
    });
    const missingSource = buildListingSourceReceipts([{
      ...item, included_with_rental: ["1× 2TB SSD"], included_with_rental_recorded_at: now - 500,
    }], "diogo", now);
    expect(missingSource[0]).not.toHaveProperty("kit_contents");
  });

  it("emits only date-matched pickup facts for the selected account", () => {
    const row = { ...item, pickup_availability: item.pickup_availability };
    expect(buildPickupFactReceipts([row], "diogo", "2026-11-27", "2026-11-29", "Northumberland Street", now)).toMatchObject([
      { account_slug: "diogo", product_id: 123, status: "currently_on_rental", pickup_area: "Northumberland Street" },
    ]);
    expect(buildPickupFactReceipts([row], "leo", "2026-11-27", "2026-11-29", "Trafalgar Square", now)).toEqual([]);
    expect(buildPickupFactReceipts([row], "diogo", "2026-11-26", "2026-11-29", "Northumberland Street", now)).toEqual([]);
  });

  it("never applies one listing's verified pickup reason to a different or multi-item basket", () => {
    const now = Date.UTC(2026, 10, 26);
    const reason = "This kit is assigned to a production set.";
    const listing = { account_slug: "diogo", product_id: 123, listing_name: "BMPCC kit", checked_at: now };
    const fact = {
      account_slug: "diogo",
      product_id: 123,
      listing_name: "BMPCC kit",
      status: "assigned_to_set",
      customer_explanation: reason,
      source: "owner-confirmed schedule",
      verified_at: now,
      valid_until: now + 60_000,
      applies_start_date: "2026-11-27",
      applies_end_date: "2026-11-29",
      checked_at: now,
    };

    expect(verifiedPickupReasonForSingleListing([listing], [fact], "diogo", now)).toBe(reason);
    expect(verifiedPickupReasonForSingleListing([listing], [{ ...fact, product_id: 456 }], "diogo", now)).toBeUndefined();
    expect(verifiedPickupReasonForSingleListing([listing, { ...listing, product_id: 456 }], [fact], "diogo", now)).toBeUndefined();
    expect(verifiedPickupReasonForSingleListing([listing], [fact, fact], "diogo", now)).toBeUndefined();
    expect(verifiedPickupReasonForSingleListing([listing], [fact], "leo", now)).toBeUndefined();
    expect(verifiedPickupReasonForSingleListing([listing], [fact], "diogo", now + 60_000)).toBeUndefined();
  });
});
