import { describe, expect, it } from "vitest";
import { resolveInventoryMount } from "./reviewed_inventory_mount";
import { requiredMountAdapters } from "./required_mount_adapter";

describe("booking addition mount evidence", () => {
  it("uses an exact manufacturer's reviewed native mount when the physical camera row is blank", () => {
    const camera = { name_canonical: "Sony FX3", kind: "camera", lens_mount: null };
    const resolved = resolveInventoryMount(camera);
    expect(resolved).toMatchObject({
      mount: "Sony E-mount",
      evidence: {
        status: "manufacturer_reviewed",
        model: "ILME-FX3",
        source_url: "https://www.sony.co.uk/electronics/support/camcorders-and-video-cameras-interchangeable-lens-camcorders/ilme-fx3/specifications",
      },
    });
    const lens = { id: "lens", name: "Sony 28-70mm", kind: "lens", mount: "Sony E-mount" };
    const body = { id: "fx3", name: camera.name_canonical, kind: "camera", mount: resolved.mount };
    expect(requiredMountAdapters([body, lens], [{ item_id: "fx3", quantity: 1 }], [{ item_id: "lens", quantity: 1 }]))
      .toMatchObject({ status: "none", items: [] });
  });

  it("resolves the owner-confirmed Sony FE lens identity against Sony's mount specification", () => {
    const lensMount = resolveInventoryMount({ name_canonical: "Sony 28-70mm", kind: "lens", lens_mount: null });
    expect(lensMount).toMatchObject({
      mount: "Sony E-mount",
      evidence: {
        status: "manufacturer_reviewed",
        model: "Sony FE 28-70mm F3.5-5.6 OSS (SEL2870)",
        identity_source: "owner-confirmed exact model",
        source_url: "https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/sel2870/specifications",
      },
    });
    const bodyMount = resolveInventoryMount({ name_canonical: "Sony FX3", kind: "camera", lens_mount: null });
    expect(requiredMountAdapters(
      [
        { id: "fx3", name: "Sony FX3", kind: "camera", mount: bodyMount.mount },
        { id: "lens", name: "Sony 28-70mm", kind: "lens", mount: lensMount.mount },
      ],
      [{ item_id: "fx3", quantity: 1 }],
      [{ item_id: "lens", quantity: 1 }],
    )).toMatchObject({ status: "none", items: [] });
  });

  it("fails closed on a conflict between inventory and the reviewed manufacturer mount", () => {
    const resolved = resolveInventoryMount({ name_canonical: "Sony FX3", kind: "camera", lens_mount: "Canon EF mount" });
    expect(resolved.mount).toBeNull();
    expect(resolved.evidence).toMatchObject({ status: "conflict", recorded_mount: "Canon EF mount", reviewed_mount: "Sony E-mount" });
  });

  it("does not infer a mount for an unmatched or fixed-lens camera", () => {
    expect(resolveInventoryMount({ name_canonical: "Unknown camera", kind: "camera", lens_mount: null }).mount).toBeNull();
    expect(resolveInventoryMount({ name_canonical: "GoPro 12 Hero", kind: "camera", lens_mount: null }).mount).toBeNull();
  });
});
