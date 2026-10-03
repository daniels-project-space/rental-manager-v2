import { describe, expect, it } from "vitest";
import { requiredMountAdapters, renterProvidedAdapters } from "./required_mount_adapter";
const items = [
  { id: "camera", name: "BMPCC 6K Full Frame", kind: "camera", mount: "L" },
  { id: "lens", name: "Blazar Remus 100mm", kind: "lens", mount: "PL" },
  { id: "adapter", name: "PL to L mount", kind: "accessory" },
];
describe("usable lens setup requirements", () => {
  it("requires one adapter for the recorded PL lens and L camera", () => {
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }])).toMatchObject({ status: "required", items: [{ name: "PL to L mount", quantity: 1 }] });
  });
  it("shares one adapter across several lenses on one camera", () => {
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 3 }]).items[0].quantity).toBe(1);
  });
  it("does not sell an adapter already included, including one in the selected kit", () => {
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 1 }, { item_id: "adapter", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).status).toBe("none");
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }, { item_id: "adapter", quantity: 1 }]).status).toBe("none");
  });
  it("does not reuse an adapter already needed by another camera's lens", () => {
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 2 }, { item_id: "lens", quantity: 1 }, { item_id: "adapter", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).items[0].quantity).toBe(1);
  });
  it("needs no adapter when native mounts match", () => {
    expect(requiredMountAdapters(items.map(item => item.id === "lens" ? { ...item, mount: "L mount" } : item), [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).status).toBe("none");
  });
  it("does not charge for the renter's explicitly supplied matching adapter", () => {
    const supplied = renterProvidedAdapters("I already have my own PL-to-L mount adapter, so quote the lens only and do not change my booking.", items);
    expect(supplied).toEqual([{ item_id: "adapter", quantity: 1 }]);
    expect(requiredMountAdapters(items, [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }], supplied).status).toBe("none");
    expect(renterProvidedAdapters("I have no PL-to-L adapter. I don't have a PL to L mount adapter.", items)).toEqual([]);
    expect(renterProvidedAdapters('My friend said "I have a PL to L mount adapter".', items)).toEqual([]);
    expect(renterProvidedAdapters("I have a PL to EF mount adapter.", items)).toEqual([]);
    expect(renterProvidedAdapters("Yes, please quote the lens.", items, supplied)).toEqual(supplied);
    expect(renterProvidedAdapters("I no longer have my PL-to-L adapter.", items, supplied)).toEqual([]);
  });
  it("does not guess unknown mounts or choose between different camera mounts", () => {
    expect(requiredMountAdapters(items.map(item => item.id === "lens" ? { ...item, mount: null } : item), [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).status).toBe("unknown");
    expect(requiredMountAdapters([...items, { id: "other", name: "Sony FX3", kind: "camera", mount: "Sony E" }], [{ item_id: "camera", quantity: 1 }, { item_id: "other", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).status).toBe("unknown");
    expect(requiredMountAdapters(items.filter(item => item.id !== "adapter"), [{ item_id: "camera", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]).status).toBe("unknown");
  });
});
