/**
 * One-off data corrections (2026-06-25, from Daniel's fact-check of the chat):
 *
 *   1. The Sony GM 24-70mm f2.8 we own is the ORIGINAL Mk I (SEL2470GM), not the
 *      Mk II — the item_specs sheet wrongly described the SEL2470GM2 (XD linear
 *      motors, 695g, 0.21m). Rewritten to the real Mk I.
 *   2. We DO own a BMPCC-Full-Frame EF-to-L mount adapter, it just wasn't
 *      catalogued, so the chat couldn't confirm the FF's "Canon EF via included
 *      adapter" spec. Add the adapter as a real accessory item (cloning the
 *      structural fields of the existing PL-to-L adapter row) and list it +
 *      the 5× LP-E6NH batteries the spec says ship with it in the FF's
 *      compatibility.included_with_rental.
 *
 * Idempotent — safe to re-run. Run once with:
 *   npx convex run admin_fix_inventory_20260625:run '{}'
 */
import { internalMutation } from "./_generated/server";

const GM2470_MK1_SPEC =
  "Sony FE 24-70mm f2.8 GM, original Mk I (SEL2470GM). 18 elements in 13 groups " +
  "(2 XA, 1 aspherical, 1 super-ED, 2 ED), Nano AR coating. Direct Drive SSM " +
  "autofocus. 886g. Min focus 0.38m, 0.24x max magnification. 9-blade circular " +
  "aperture, 82mm filter. Native Sony E-mount, full frame. The constant-f2.8 " +
  "standard-zoom workhorse — events, weddings, portraits, run-and-gun.";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, unknown> = {};

    // 1) GM 24-70 spec → Mk I.
    const specs = await ctx.db.query("item_specs").collect();
    const gmSpec = specs.find(
      (s) => s.item_name_canonical === "Sony GM 24-70mm f2.8",
    );
    if (gmSpec) {
      await ctx.db.patch(gmSpec._id, { description: GM2470_MK1_SPEC });
      out.gm_spec = "patched to Mk I";
    } else {
      out.gm_spec = "no item_specs row found";
    }

    const items = await ctx.db.query("items").collect();

    // 2a) Add the EF-to-L adapter as a real accessory, cloning the PL-to-L row's
    //     structural fields so it sits in the same category/kind as the other
    //     mount adapters.
    let adapterName = "EF to L mount";
    const existingAdapter = items.find(
      (i) => i.name_canonical.toLowerCase() === "ef to l mount",
    );
    if (existingAdapter) {
      out.adapter = "already present";
      adapterName = existingAdapter.name_canonical;
    } else {
      const sibling = items.find((i) => i.name_canonical === "PL to L mount");
      if (sibling) {
        const now = Date.now();
        await ctx.db.insert("items", {
          name_canonical: "EF to L mount",
          name_input: "EF to L mount",
          slug: "ef-to-l-mount",
          kind: sibling.kind,
          unit_kind: sibling.unit_kind,
          qty: 1,
          ...(sibling.category_v1 ? { category_v1: sibling.category_v1 } : {}),
          is_marketing_only: false,
          status: "active",
          aliases: [
            "EF-L adapter",
            "Canon EF to L mount adapter",
            "EF to L adapter",
            "EF-to-L mount",
          ],
          notes:
            "Canon EF lens to L-mount body adapter — lets the Canon EF glass run on the L-mount BMPCC 6K Full Frame. Ships with the FF rental.",
          created_at: now,
          updated_at: now,
        });
        out.adapter = "added";
      } else {
        out.adapter = "no PL-to-L sibling to clone from";
      }
    }

    // 2b) BMPCC 6K Full Frame bundle now lists the adapter + the 5× LP-E6NH
    //     batteries the spec says are included.
    const ff = items.find((i) => i.name_canonical === "BMPCC 6K Full Frame");
    if (ff) {
      const comp = ff.compatibility ?? {};
      const inc = new Set(comp.included_with_rental ?? []);
      inc.add("Canon EF-to-L mount adapter");
      inc.add("LP-E6NH batteries 5x");
      await ctx.db.patch(ff._id, {
        compatibility: { ...comp, included_with_rental: [...inc] },
        updated_at: Date.now(),
      });
      out.ff_bundle = [...inc];
    } else {
      out.ff_bundle = "no BMPCC 6K Full Frame row found";
    }

    return out;
  },
});
