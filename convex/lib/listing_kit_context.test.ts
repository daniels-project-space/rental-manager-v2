import {describe,it,expect} from "vitest";
import type {Doc} from "../_generated/dataModel";
import type {QueryCtx} from "../_generated/server";
import {listingKitContext} from "./listing_kit_context";

const components=[
  {item_id:"body",name:"BMPCC 6K Full Frame",kind:"camera",units_per_listing:1,stock_required:true},
  {item_id:"battery",name:"NP-F570 batteries",kind:"accessory",units_per_listing:5,stock_required:true},
  {item_id:"card",name:"CFexpress Type B card",kind:"accessory",units_per_listing:1,stock_required:true},
];
const override={
  account_slug:"dbcinema",product_id:1103089,
  components:[{item_id:"body",qty:1},{item_id:"battery",qty:5},{item_id:"card",qty:1}],
  owner_confirmed_kit_contents:{
    lines:["5× NP-F570 batteries","1× Lexar Professional 1TB CFexpress Type B card","Tilta cage"],
    mapping_components:[{item_id:"body",qty:1},{item_id:"battery",qty:5},{item_id:"card",qty:1}],
    source:"Owner-confirmed Lab scenario for DB Cinema listing 1103089",recorded_at:123,
  },
} as unknown as Doc<"listing_resolution_override">;
const inventory=[
  {_id:"body",name_canonical:"BMPCC 6K Full Frame",kind:"camera",compatibility:{included_with_rental:["3× NP-F570 batteries","1× Samsung 1TB SSD"]}},
  {_id:"battery",name_canonical:"NP-F570 batteries",kind:"accessory"},
  {_id:"card",name_canonical:"CFexpress Type B card",kind:"accessory"},
] as unknown as Doc<"items">[];
const sources={indexes:[],overrides:[override],peers:[]} as unknown as Parameters<typeof listingKitContext>[5];

describe("listing-scoped owner kit contents",()=>{
  it("uses the exact listing manifest over shared item notes and refines a generic mapped card",async()=>{
    const result=await listingKitContext({} as QueryCtx,"dbcinema",inventory[0],components as any,inventory,sources,1103089);
    expect(result.included_with_rental).toEqual(override.owner_confirmed_kit_contents!.lines);
    expect(result.included_with_rental_source).toContain("DB Cinema listing 1103089");
    expect(result.included_with_rental_recorded_at).toBe(123);
    expect(result.kit.contents).toContain("1 × Lexar Professional 1TB CFexpress Type B card");
    expect(result.kit.contents).not.toContain("3× NP-F570 batteries");
    expect(result.kit.contents).not.toContain("1× Samsung 1TB SSD");
    expect(result.contents_review_required).toBe(false);
  });

  it("returns provenance for an exact owner-verified inventory manifest",async()=>{
    const lines=["5× NP-F570 batteries","1× 2TB SSD"];
    const item={_id:"body",name_canonical:"BMPCC 6K Pro",kind:"camera",updated_at:456,
      compatibility:{included_with_rental:lines},owner_verified_kit:{source:"owner-confirmed kit contents",contents:lines}} as unknown as Doc<"items">;
    const result=await listingKitContext({} as QueryCtx,"dbcinema",item,[],[item],{indexes:[],overrides:[],peers:[]} as any,undefined);
    expect(result.included_with_rental).toEqual(lines);
    expect(result.included_with_rental_source).toBe("owner-confirmed kit contents");
    expect(result.included_with_rental_recorded_at).toBe(456);
  });

  it("does not carry owner-confirmed contents to another listing or account",async()=>{
    const otherListing=await listingKitContext({} as QueryCtx,"dbcinema",inventory[0],components as any,inventory,sources,1103090);
    const otherAccount=await listingKitContext({} as QueryCtx,"leo",inventory[0],components as any,inventory,sources,1103089);
    for(const result of [otherListing,otherAccount]) {
      expect(result.included_with_rental_source).toBeNull();
      expect(result.included_with_rental).not.toContain("5× NP-F570 batteries");
      expect(result.included_with_rental).not.toContain("1× Lexar Professional 1TB CFexpress Type B card");
    }
  });

  it("keeps the exact owner manifest when listing text only expands a primary-item mapping",async()=>{
    const bodyOnly={...override,
      components:[{item_id:"body",qty:1}],
      owner_confirmed_kit_contents:{...override.owner_confirmed_kit_contents!,mapping_components:[{item_id:"body",qty:1}]},
    } as unknown as Doc<"listing_resolution_override">;
    const derivedSources={indexes:[],overrides:[bodyOnly],peers:[]} as unknown as Parameters<typeof listingKitContext>[5];
    const result=await listingKitContext({} as QueryCtx,"dbcinema",inventory[0],components as any,inventory,derivedSources,1103089);
    expect(result.included_with_rental).toEqual(bodyOnly.owner_confirmed_kit_contents!.lines);
    expect(result.included_with_rental_source).toContain("DB Cinema listing 1103089");
    expect(result.kit.contents).toContain("Tilta cage");
    expect(result.contents_review_required).toBe(false);
  });

  it("drops a manifest when its physical component mapping has changed",async()=>{
    const changed=components.slice(0,2);
    const result=await listingKitContext({} as QueryCtx,"dbcinema",inventory[0],changed as any,inventory,sources,1103089);
    expect(result.included_with_rental_source).toBeNull();
    expect(result.included_with_rental).not.toContain("1× Lexar Professional 1TB CFexpress Type B card");
  });
});
