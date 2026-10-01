import { describe, it, expect } from "vitest";
import { passesNameSanityCheck } from "./reservations/itemResolution";

describe("item name checks", () => {
  const matches = (canonical: string, title: string) => passesNameSanityCheck(canonical, [{ name: title }]);
  it("does not confuse focal lengths sharing an aperture", () => {
    expect(matches("Sony GM 16-35mm f2.8", "Sony 24-70mm f2.8 GM lens")).toBe(false);
    expect(matches("Sony GM 16-35mm f2.8", "Sony 16-35mm G master f2.8")).toBe(true);
  });
  it("does not confuse model prefixes or generations", () => {
    expect(matches("Sony FX3", "Sony FX30")).toBe(false);
    expect(matches("Sony A7 III", "Sony A7S III")).toBe(false);
    expect(matches("DJI RS3 Pro", "DJI RS4 Pro")).toBe(false);
    expect(matches("Sony A7 III", "Sony A7III camera")).toBe(true);
    expect(matches("Sony FX3", "Sony FX 3 camera")).toBe(true);
    expect(matches("Sony FX3", "Sony FX3 24-70mm kit")).toBe(true);
  });
  it("does not borrow identities from comparison copy or other listing lines", () => {
    expect(matches("Sony A7S III", "Sony FX3 (same sensor as A7S III)")).toBe(false);
    expect(passesNameSanityCheck("Sony GM 16-35mm f2.8", [{ name: "16-35mm f4" }, { name: "24-70mm f2.8" }])).toBe(false);
  });
  it("does not label a tripod as a C stand", () => {
    expect(matches("C-Stand", "Cinema tripod stand")).toBe(false);
    expect(matches("C-Stand", "Heavy duty C-stand")).toBe(true);
  });
  it("requires standalone model numbers and rejects incompatible brands", () => {
    expect(matches("GoPro 12 Hero", "GoPro Hero 11")).toBe(false);
    expect(matches("Canon R5", "Sony R5 camera")).toBe(false);
  });
  it("recognizes lens typography", () => {
    expect(matches("Sony GM 16-35mm f2.8", "Sony 16–35 mm f/2.8")).toBe(true);
  });
});
