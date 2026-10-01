import { describe, expect, it } from "vitest";
import { unknownKitItems } from "./renter_kit_evidence";
describe("canonical kit evidence", () => {
  it("does not contradict a server-supplied mapped kit when listing prose is absent", () => {
    expect(unknownKitItems([], [{ name: "Sony A7 V Full Frame Camera", description: null }], ["Sony A7 V Full Frame Camera"])).toEqual([]);
  });
  it("keeps a second unknown kit guarded in a mixed basket", () => {
    expect(unknownKitItems(["Unknown kit"], [{ name: "Known kit", description: null }, { name: "Unknown kit", description: null }], ["Known kit"])).toEqual(["Unknown kit"]);
  });
  it("does not use partial name matching to excuse another model", () => {
    expect(unknownKitItems([], [{ name: "Sony A7R V", description: null }], ["Sony A7 V"])).toEqual(["Sony A7R V"]);
  });
});
