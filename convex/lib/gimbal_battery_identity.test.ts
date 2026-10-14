import { describe, expect, it } from "vitest";
import { resolveBundleMapping } from "./bundle_mapping";
import { apply } from "../seed/bg30_stock_repair";

const gimbal = { _id: "gimbal", name_canonical: "DJI RS3 Pro gimbal", kind: "gimbal", qty: 2 };
const battery = {
  _id: "battery", name_canonical: "DJI gimbal battery", kind: "power", qty: 3,
  track_independent_stock: true,
  aliases: ["DJI RS3 Pro Gimbal Batteries", "DJI RS3 Pro batteries", "DJI Ronin RS2 RS3 Pro Gimbal Battery", "DJI RS BG30 grip battery"],
};
const inventory = [gimbal, battery];
const resolve = (line: string) => resolveBundleMapping(`Included in this kit:\n* ${line}`, inventory);

describe("gimbal versus spare battery stock identity", () => {
  it.each([
    ["1x Dji RS3 pro batteries", 1],
    ["2x Dji RS3 pro batteries", 2],
    ["1x DJI Ronin RS2 / RS3 Pro Gimbal Battery", 1],
    ["2x DJI RS3 Pro Gimbal Batteries", 2],
  ])("maps actual spare contents %s to batteries only", (line, qty) => {
    const result = resolve(line as string);
    expect(result.unmatched).toEqual([]);
    expect(result.components.map(c => [c.item_id, c.qty])).toEqual([["battery", qty]]);
  });

  it.each([1, 2])("does not invent a gimbal for the legacy %i-spare extra wording", qty => {
    // Legacy 'extra' lines are excluded by the paid-add-on parser. These
    // listings need an explicit reviewed override, never a gimbal fallback.
    expect(resolve(`${qty}x Dji RS3 pro batteries extra for a total of 4-8 hours more battery life`).components).toEqual([]);
  });

  it.each(["DJI RS3 Pro gimbal", "DJI RS3 Pro gimbal with battery", "DJI RS3 Pro gimbal including batteries"])("keeps the complete gimbal: %s", line => {
    expect(resolve(`1x ${line}`).components.map(c => c.item_id)).toEqual(["gimbal"]);
  });

  it("never uses a battery alias to fill an unowned RS2 gimbal", () => {
    const result = resolve("1x DJI RS2 Ronin gimbal");
    expect(result.components).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
  });

  it("does not replace a charger with either a gimbal or a battery", () => {
    expect(resolve("1x DJI RS3 Pro gimbal battery charger").components).toEqual([]);
  });

  it("does not map a generic camera battery to the gimbal", () => {
    expect(resolve("2x camera batteries").components).toEqual([]);
  });

  it("preserves camera and light objects with supplied battery power", () => {
    const body = { _id: "body", name_canonical: "Sony A7S III", kind: "camera", qty: 1 };
    const light = { _id: "light", name_canonical: "Aputure MC light", kind: "light", qty: 1 };
    const result = resolveBundleMapping("Included in this kit:\n* 1x Sony A7S III with batteries\n* 1x battery-powered Aputure MC light", [...inventory, body, light]);
    expect(result.components.map(c => c.item_id)).toEqual(["body", "light"]);
  });
});

describe("atomic BG30 catalogue correction", () => {
  function fixture() {
    const rows: Record<string, any[]> = {
      items: [{ ...battery, _id: "kn79kzg6j393vz9mjh7ghqx0gn86bz73", battery_type: "DJI RS BG30 grip battery", aliases: [], track_independent_stock: undefined, status: "active", is_marketing_only: false }, { ...gimbal, status: "active", is_marketing_only: false }],
      hygglo_products: [["dbcinema", 856455, 1], ["dbcinema", 856472, 2], ["diogo", 1173490, 1], ["diogo", 1173716, 2]].map(([accountSlug, productId, qty]) => ({ accountSlug, productId, masterItemId: "gimbal", name: "DJI Ronin gimbal batteries", description: `Included in this kit:\n* ${qty}x DJI RS3 Pro Gimbal Batteries` })),
      listing_resolution_override: [], audit_log: [], settings: [{ _id: "settings", draft_epoch: 4 }],
    };
    const writes: string[] = [];
    const db = {
      query(table: string) {
        let selected = rows[table];
        const query = { withIndex(_name: string, callback: any) { const index = { eq(key: string, value: unknown) { selected = selected.filter(row => row[key] === value); return index; } }; callback(index); return query; }, async take(n: number) { return selected.slice(0, n); }, async first() { return selected[0] ?? null; } };
        return query;
      },
      async patch(id: string, change: any) { const row = Object.values(rows).flat().find(row => row._id === id); if (!row) throw Error("Unknown record"); Object.assign(row, change); writes.push(`patch:${id}`); },
      async insert(table: string, change: any) { const id = `${table}:${rows[table].length}`; rows[table].push({ ...change, _id: id }); writes.push(`insert:${table}`); return id; },
    };
    return { rows, writes, run: (dry_run?: boolean) => (apply as any)._handler({ db }, { dry_run }) };
  }

  it("previews without writes, applies four mappings atomically, and replays without extra writes", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ preview: true, inserted: 4, quantityOwned: 3 });
    expect(f.writes).toEqual([]);
    expect(await f.run(false)).toMatchObject({ preview: false, inserted: 4, quantityOwned: 3 });
    expect(f.rows.listing_resolution_override).toHaveLength(4);
    expect(f.rows.settings[0].draft_epoch).toBe(5);
    expect(f.rows.items[0].qty).toBe(3);
    const writes = [...f.writes];
    expect(await f.run(false)).toMatchObject({ inserted: 0, metadataChanged: false });
    expect(f.writes).toEqual(writes);
  });

  it.each(["quantity", "description", "override"])("refuses changed %s before any write", async kind => {
    const f = fixture();
    if (kind === "quantity") f.rows.items[0].qty = 4;
    if (kind === "description") f.rows.hygglo_products[3].description = "Included in this kit:\n* 1x DJI RS3 Pro gimbal";
    if (kind === "override") f.rows.listing_resolution_override.push({ account_slug: "diogo", product_id: 1173716, source: "manual_audit", note: "Owner decision", components: [] });
    await expect(f.run(false)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
});
