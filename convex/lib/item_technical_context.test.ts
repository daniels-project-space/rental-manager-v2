import { describe, expect, it } from "vitest";
import { equipmentUsageContext, itemTechnicalContext, equipmentFactRequests } from "./item_technical_context";

describe("technical evidence reaching the generation prompt", () => {
  it("preserves reviewed camera modes and their mandatory conditions",()=>{
    const context=itemTechnicalContext({camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",internal_4k:true,built_in_nd:false,
      recording_modes:[{resolution:"uhd_4k",nominal_fps:[120],capture_format:"aps_c",full_width:false,internal:true,conditions:["APS-C crop required"],verified_model:"Sony A7 V",source_url:"https://sony.com/modes",verified_at:1}]}});
    expect(context).toContain('"built_in_nd":false');
    expect(context).toContain('"capture_format":"aps_c"');
    expect(context).toContain("APS-C crop required");
    expect(context).toContain("Omitted properties and recording modes are unknown");
  });
  it("preserves exact identity, source and manual-focus facts in a recommendation", () => {
    const context = itemTechnicalContext({
      spec_text: "11mm fisheye, Sony E mount.",
      spec_verification: { model: "TTArtisan 11mm f/2.8", source_url: "https://ttartisan.com/" },
      lens_capabilities: { model: "TTArtisan 11mm f/2.8", source_url: "https://ttartisan.com/", focus_mode: "manual_focus", projection: "fisheye" },
    });
    expect(context).toContain("TTArtisan 11mm f/2.8");
    expect(context).toContain("https://ttartisan.com/");
    expect(context).toContain('"focus_mode":"manual_focus"');
    expect(context).toContain('"projection":"fisheye"');
    expect(context).toContain("Focus mode does not establish electronic contacts");
  });
  it("does not infer a camera from a lens-only rental", () => {
    const context = equipmentUsageContext([{ inventory_components: [
      { name: "TTArtisan 11mm f/2.8 (Sony E)", kind: "lens", owned: true },
    ] }]);
    expect(context.supplied_camera_bodies).toEqual([]);
    expect(context.renter_camera_body).toBeNull();
  });
  it("preserves all supplied bodies without selecting the renter's camera", () => {
    const context = equipmentUsageContext([{ inventory_components: [
      { name: "Sony FX3", kind: "camera", owned: true },
      { name: "Sony FX3", kind: "camera", owned: true },
      { name: "Canon R5", kind: "camera_body", owned: true },
    ] }]);
    expect(context.supplied_camera_bodies).toEqual(["Sony FX3", "Canon R5"]);
    expect(context.renter_camera_body).toBeNull();
  });
  it("does not promote unowned or unresolved components into supplied cameras", () => {
    expect(equipmentUsageContext([{ inventory_components: [
      { name: "Canon R5", kind: "camera_body", owned: false },
      { name: "Sony FX3", kind: "camera", owned: null },
      { name: null, kind: "camera", owned: true },
    ] }, {}]).supplied_camera_bodies).toEqual([]);
  });
  it("does not promote legacy prose into reviewed specifications", () => {
    const context = itemTechnicalContext({ spec_text: "Sony autofocus lens" });
    expect(context).not.toContain("Sony autofocus lens");
    expect(context).toContain("not reviewed");
  });
});

describe("equipment facts resolve owned identities without recommendation filters",()=>{
  const items=[
    {name_canonical:"BMPCC 6K Pro",aliases:["Blackmagic Pocket Cinema Camera 6K Pro"],status:"active",qty:1},
    {name_canonical:"BMPCC 6K Full Frame",status:"active",qty:1},
    {name_canonical:"Sony FX3",status:"active",qty:1},
    {name_canonical:"Sony FX30",status:"active",qty:1,is_marketing_only:true},
    {name_canonical:"Canon C70",status:"inactive",qty:1},
    {name_canonical:"Sony A7 III",status:"active",qty:0},
  ];
  it("resolves exact reviewed identities and aliases in a deduplicated batch",()=>{
    const result=equipmentFactRequests(["Blackmagic Pocket Cinema Camera 6K Pro","Sony FX3","Sony FX3"],items);
    expect(result.map(r=>r.item?.name_canonical)).toEqual(["BMPCC 6K Pro","Sony FX3"]);
  });
  it("does not substitute unowned, absent or ambiguous equipment",()=>{
    for(const name of ["Sony FX30","Canon C70","Sony A7 III","BMPCC 6K","Canon C500"])
      expect(equipmentFactRequests([name],items)[0].item,name).toBeNull();
  });
  it("bounds requested work and rejects empty names",()=>{
    expect(()=>equipmentFactRequests(Array(7).fill("Sony FX3"),items)).toThrow();
    expect(()=>equipmentFactRequests([" "],items)).toThrow();
    expect(()=>equipmentFactRequests(["x".repeat(161)],items)).toThrow();
    expect(equipmentFactRequests([],items)).toEqual([]);
  });
});
