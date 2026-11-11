import { describe, expect, it } from "vitest";
import { classifyOrderWeight, quoteDeliveryPrice, tooHeavyForLocation } from "./delivery_weight";

describe("quoteDeliveryPrice", () => {
  it("uses DB Cinema's distance bands and round-trip margin", () => {
    const basket = [{ spec: { kind: "accessory", weight_kg: 2, size_score: 2 }, qty: 1 }];
    const atThreeKm = quoteDeliveryPrice(basket, 3);
    const justOverThreeKm = quoteDeliveryPrice(basket, 3.01);

    expect(atThreeKm).toMatchObject({ ok: true, vehicle: "motorcycle", oneWay: 17, fee: 37 });
    expect(justOverThreeKm).toMatchObject({ ok: true, vehicle: "motorcycle", oneWay: 22, fee: 48 });
  });

  it("raises the courier class and quote when basket weight crosses the bike limit", () => {
    const light = quoteDeliveryPrice(
      [{ spec: { kind: "accessory", weight_kg: 2, size_score: 2 }, qty: 1 }],
      5,
    );
    const heavy = quoteDeliveryPrice(
      [{ spec: { kind: "accessory", weight_kg: 9, size_score: 2 }, qty: 1 }],
      5,
    );

    expect(light).toMatchObject({ ok: true, vehicle: "motorcycle", fee: 48 });
    expect(heavy).toMatchObject({ ok: true, vehicle: "car", fee: 64 });
  });

  it("counts distinct basket specs for the bike cutoff but includes quantity in weight", () => {
    const quote = quoteDeliveryPrice(
      [{ spec: { kind: "storage_card", weight_kg: 0.1, size_score: 1 }, qty: 4 }],
      5,
    );

    expect(quote).toMatchObject({ ok: true, vehicle: "motorcycle", totalWeightKg: 0.4 });
  });

  it("selects a van for two bulky items and refuses empty or out-of-range quotes", () => {
    const van = quoteDeliveryPrice(
      [
        { spec: { kind: "lighting", weight_kg: 5, size_score: 4 }, qty: 1 },
        { spec: { kind: "lighting", weight_kg: 5, size_score: 4 }, qty: 1 },
      ],
      10,
    );

    expect(van).toMatchObject({ ok: true, vehicle: "van" });
    expect(quoteDeliveryPrice([], 5)).toEqual({ ok: false, reason: "empty_basket" });
    expect(quoteDeliveryPrice([{ spec: { kind: "camera" }, qty: 1 }], 30.1)).toEqual({
      ok: false,
      reason: "out_of_range",
    });
  });

  it("keeps a heavy basket out of the short heavy-item delivery radius", () => {
    const basket = [{ spec: { kind: "camera", weight_kg: 2, size_score: 3 }, qty: 1 }];
    const weight = classifyOrderWeight(basket);

    expect(tooHeavyForLocation(weight, 10, 5, 30)).toMatchObject({
      tooHeavy: true,
      outOfRange: false,
    });
  });
});
