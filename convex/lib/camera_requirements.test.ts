import {reviewFullFrameDci4k} from "../admin_verify_camera_capabilities_20261001";
import {fullFrameDci4kMode} from "./blackmagic_recording_review";
import { describe, expect, it } from "vitest";
import { assessCameraRequirements, meetsCameraRequirements, requestedCameraRole, verifiedCameraCapabilities, type CameraCapabilities, type RecordingMode } from "./camera_requirements";
const full: CameraCapabilities = { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "L", internal_4k: true };
const action: CameraCapabilities = { role: "action", sensor_format: "small_sensor", internal_4k: true };
describe("hard camera requirements before stock ranking", () => {
  it("qualifies the reviewed Full Frame DCI mode without borrowing UHD, uncropped or supplied-media proof",()=>{
    const caps={...full,recording_modes:[fullFrameDci4kMode(2)]};
    expect(assessCameraRequirements(caps,{recording:{resolution:"dci_4k",min_fps:60,internal:true}}).status).toBe("match");
    for(const recording of [{resolution:"dci_4k" as const,min_fps:60,full_width:true},{resolution:"dci_4k" as const,min_fps:120},{resolution:"uhd_4k" as const,min_fps:60},{resolution:"dci_4k" as const,capture_format:"full_frame" as const},{resolution:"dci_4k" as const,capture_format:"super35" as const}])
      expect(assessCameraRequirements(caps,{recording}).status).toBe("unknown");
    expect(assessCameraRequirements(caps,{built_in_nd:true}).status).toBe("unknown");
    expect(caps.recording_modes[0].conditions.join(" ")).toContain("windowed sensor");
  });
  it("uses reviewed internal 4K as broad recording proof in either representation",()=>{
    for(const internal of [undefined,true])expect(assessCameraRequirements(full,{recording:{resolution:"4k",...(internal===undefined?{}:{internal})}}).status).toBe("match");
    expect(assessCameraRequirements(full,{internal_4k:true}).status).toBe("match");
    for(const capabilities of [null,{...full,internal_4k:false}])
      expect(assessCameraRequirements(capabilities,{recording:{resolution:"4k"}}).status).toBe("unknown");
    expect(assessCameraRequirements({...full,internal_4k:false},{recording:{resolution:"4k",internal:true}}).status).toBe("mismatch");
    expect(assessCameraRequirements(full,{internal_4k:false,recording:{resolution:"4k"}}).status).toBe("mismatch");
  });
  it("never promotes broad 4K proof into a detailed recording mode",()=>{
    for(const recording of [{resolution:"uhd_4k" as const},{resolution:"dci_4k" as const},
      {resolution:"4k" as const,min_fps:24},{resolution:"4k" as const,capture_format:"full_frame" as const},
      {resolution:"4k" as const,full_width:true},{resolution:"4k" as const,full_width:false},
      {resolution:"4k" as const,internal:false}])
      expect(assessCameraRequirements(full,{recording}),JSON.stringify(recording)).toMatchObject({status:"unknown",unknown:["recording"]});
  });
  const mode = (fps: number, format: "full_frame" | "aps_c", width: boolean): RecordingMode => ({ resolution: "uhd_4k", nominal_fps: [fps], capture_format: format, full_width: width, internal: true, conditions: [], verified_model: "model", source_url: "https://manufacturer.example/modes", verified_at: 1 });
  it("distinguishes full-frame sensors from capture area and uncropped modes", () => {
    const a7v = { ...full, recording_modes: [mode(60, "full_frame", true), mode(120, "aps_c", false)] };
    const fx3 = { ...full, recording_modes: [mode(60, "full_frame", true), mode(120, "full_frame", false)] };
    const requirement = { recording: { resolution: "uhd_4k" as const, min_fps: 120, capture_format: "full_frame" as const, internal: true } };
    expect(meetsCameraRequirements(a7v, requirement)).toBe(false);
    expect(meetsCameraRequirements(fx3, requirement)).toBe(true);
    expect(meetsCameraRequirements(fx3, { recording: { ...requirement.recording, full_width: true } })).toBe(false);
    expect(meetsCameraRequirements(a7v, { recording: { ...requirement.recording, min_fps: 60, full_width: true } })).toBe(true);
    expect(meetsCameraRequirements(full, requirement)).toBe(false);
  });
  it("keeps a generic 4K requirement separate from explicit UHD/DCI mode proof",()=>{
    const uhd=mode(60,"full_frame",true),dci={...uhd,resolution:"dci_4k" as const};
    expect(meetsCameraRequirements({...full,recording_modes:[dci]},{recording:{resolution:"dci_4k"}})).toBe(true);
    expect(meetsCameraRequirements({...full,recording_modes:[uhd]},{recording:{resolution:"dci_4k"}})).toBe(false);
    const requirement={recording:{resolution:"4k" as const,min_fps:60,capture_format:"full_frame" as const,full_width:true,internal:true}};
    for(const recording_modes of [[uhd],[dci]])expect(meetsCameraRequirements({...full,recording_modes},requirement)).toBe(true);
    expect(meetsCameraRequirements({...full,recording_modes:[uhd]},{recording:{...requirement.recording,resolution:"dci_4k"}})).toBe(false);
    expect(meetsCameraRequirements({...full,recording_modes:[dci]},{recording:{...requirement.recording,resolution:"uhd_4k"}})).toBe(false);
    for(const recording_modes of [[],[{...dci,capture_format:"aps_c" as const}],[{...dci,full_width:false}],[{...dci,internal:false}],[{...dci,nominal_fps:[30]}]])expect(meetsCameraRequirements({...full,recording_modes},requirement)).toBe(false);
  });
  it("separates missing mode proof from a known incompatible body or mount",()=>{
    const reviewed={...full,recording_modes:[mode(60,"full_frame",true)],built_in_nd:false};
    const recording={resolution:"dci_4k" as const,min_fps:60,full_width:true};
    expect(assessCameraRequirements(reviewed,{recording})).toMatchObject({status:"unknown",unknown:["recording"],mismatched:[]});
    expect(assessCameraRequirements(null,{sensor_format:"full_frame",built_in_nd:true})).toMatchObject({status:"unknown",unknown:["sensor_format","built_in_nd"]});
    expect(assessCameraRequirements({...reviewed,internal_4k:false},{recording:{...recording,internal:true}})).toMatchObject({status:"mismatch",mismatched:["internal_4k"]});
    expect(assessCameraRequirements(reviewed,{recording,built_in_nd:true})).toMatchObject({status:"mismatch",mismatched:["built_in_nd"]});
    expect(assessCameraRequirements(action,{role:"interchangeable_lens",recording})).toMatchObject({status:"mismatch",mismatched:["role"]});
    expect(assessCameraRequirements(reviewed,{recording},"E")).toMatchObject({status:"mismatch",mismatched:["native_mount"]});
    expect(assessCameraRequirements({...reviewed,native_mount:undefined},{recording},"E")).toMatchObject({status:"unknown",unknown:["native_mount","recording"]});
    expect(assessCameraRequirements(reviewed,{recording:{resolution:"4k",min_fps:0}}).status).toBe("mismatch");
  });
  it("excludes physically impossible capture without inventing missing mode facts",()=>{
    const recording={resolution:"dci_4k" as const,min_fps:60,capture_format:"full_frame" as const,full_width:true,internal:true};
    for(const sensor_format of ["small_sensor","aps_c","super35"] as const)
      expect(assessCameraRequirements({...full,sensor_format},{recording})).toMatchObject({status:"mismatch",mismatched:["capture_format"]});
    expect(assessCameraRequirements(action,{internal_4k:true,recording},"E")).toMatchObject({status:"mismatch",mismatched:["capture_format"]});
    expect(assessCameraRequirements(full,{recording})).toMatchObject({status:"unknown",unknown:["recording"],mismatched:[]});
    expect(assessCameraRequirements(null,{recording})).toMatchObject({status:"unknown",mismatched:[]});
    // Cropped modes remain possible, but still need their own positive proof.
    expect(assessCameraRequirements(full,{recording:{...recording,capture_format:"aps_c"}}).status).toBe("unknown");
    expect(assessCameraRequirements({...full,sensor_format:"aps_c"},{recording:{...recording,capture_format:"super35"}}).status).toBe("unknown");
    expect(assessCameraRequirements(action,{recording:{...recording,capture_format:"small_sensor"}}).status).toBe("unknown");
  });
  it("rejects stale or wrong-model mode proof independently of a valid body profile", () => {
    const spec = { item_name_canonical: "Body", description: "Reviewed", source: "manufacturer-verified", source_url: "https://manufacturer.example/body", verified_model: "model", verified_at: 2,
      camera_capabilities: { ...full, verified_model: "model", verified_at: 2, source_url: "https://manufacturer.example/body", recording_modes: [mode(120, "aps_c", false), { ...mode(60, "full_frame", true), verified_at: 2 }, { ...mode(120, "full_frame", true), verified_at: 2, verified_model: "other-model" }] } };
    expect(verifiedCameraCapabilities(spec, "Body")?.recording_modes).toHaveLength(1);
    expect(verifiedCameraCapabilities(spec, "Body")?.recording_modes?.[0].nominal_fps).toEqual([60]);
  });
  it("does not substitute action cameras for the actual two-body Pyxis request", () => {
    const role = requestedCameraRole("Blackmagic Pyxis", "camera");
    expect(role).toBe("interchangeable_lens");
    expect(meetsCameraRequirements(action, { role: role! })).toBe(false);
    expect(meetsCameraRequirements(full, { role: role! })).toBe(true);
  });
  it("preserves action-camera and generic-camera intent", () => {
    expect(requestedCameraRole("GoPro HERO12", "camera")).toBe("action");
    expect(requestedCameraRole("DJI Osmo Action 5 Pro", "camera")).toBe("action");
    expect(requestedCameraRole("RED Komodo", "camera_body")).toBe("interchangeable_lens");
    expect(requestedCameraRole("A camera", "camera")).toBe(null);
    expect(requestedCameraRole("Sony a7 lens", "lens")).toBe(null);
  });
  it("combines sensor, native mount and internal recording requirements", () => {
    expect(meetsCameraRequirements(full, { sensor_format: "full_frame", internal_4k: true }, "Leica L-mount")).toBe(true);
    expect(meetsCameraRequirements({ ...full, internal_4k: false }, { internal_4k: true })).toBe(false);
    expect(meetsCameraRequirements({ ...full, sensor_format: "super35", native_mount: "EF" }, { sensor_format: "full_frame" }, "L")).toBe(false);
    expect(meetsCameraRequirements(full, { built_in_nd: true })).toBe(false);
  });
  it("does not claim unknown or unverified capabilities meet a requirement", () => {
    expect(meetsCameraRequirements(null, { role: "interchangeable_lens" })).toBe(false);
    expect(meetsCameraRequirements(null, {})).toBe(true);
    const spec = { item_name_canonical: "Actual body", description: "Full frame", source: "v1-handwritten", verified_at: 1, verified_model: "model", camera_capabilities: full };
    expect(verifiedCameraCapabilities(spec, "Actual body")).toBe(null);
    const reviewed = { ...spec, source: "manufacturer-verified", source_url: "https://manufacturer.example/model", camera_capabilities: { ...full, verified_model: "model", verified_at: 1, source_url: "https://manufacturer.example/model" } };
    expect(verifiedCameraCapabilities(reviewed, "Actual body")).toMatchObject(full);
    expect(verifiedCameraCapabilities({ ...reviewed, verified_model: "new-model" }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...reviewed, verified_at: 2 }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...reviewed, camera_capabilities: full }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...spec, source: "owner-verified" }, "Another body")).toBe(null);
  });
});

describe("targeted Full Frame recording source review",()=>{
 function fixture(){
  const item={_id:"ff",name_canonical:"BMPCC 6K Full Frame",kind:"camera"};
  const existing={...full,verified_model:"Blackmagic Cinema Camera 6K",source_url:"https://www.blackmagicdesign.com/products/blackmagiccinemacamera/techspecs",verified_at:1};
  const spec:any={_id:"spec",item_name_canonical:item.name_canonical,description:"Reviewed exact model",source:"manufacturer-verified",verified_model:existing.verified_model,source_url:existing.source_url,verified_at:1,camera_capabilities:existing};
  let patches=0;
  const ctx={db:{query:(table:string)=>({withIndex:()=>({unique:async()=>table==="items"?item:spec})}),patch:async(_id:string,fields:any)=>{patches++;Object.assign(spec,fields);}}};
  return {ctx,spec,existing,get patches(){return patches;}};
 }
 const invoke=(f:any,args:any={})=>(reviewFullFrameDci4k as any)._handler(f.ctx,args);
 it("preserves the original sensor, ND, provenance and specification record",async()=>{
  const f=fixture(),before=structuredClone(f.spec);
  const result=await invoke(f);
  expect(result.changed).toBe(true);expect(f.patches).toBe(1);
  const {recording_modes,...unchanged}=f.spec.camera_capabilities;
  expect(unchanged).toEqual(f.existing);expect(recording_modes).toHaveLength(1);
  expect({...f.spec,camera_capabilities:before.camera_capabilities}).toEqual(before);
  // Database serialization can reorder object keys without changing a review.
  f.spec.camera_capabilities.recording_modes=recording_modes.map((m:any)=>Object.fromEntries(Object.entries(m).sort(([a],[b])=>a.localeCompare(b))));
  expect((await invoke(f)).changed).toBe(false);expect(f.patches).toBe(1);
 });
 it("makes dry run read-only and refuses a competing prior mode review",async()=>{
  const f=fixture();expect((await invoke(f,{dry_run:true})).changed).toBe(false);expect(f.patches).toBe(0);
  f.spec.camera_capabilities.recording_modes=[{...fullFrameDci4kMode(1),full_width:true}];
  await expect(invoke(f)).rejects.toThrow("reconciliation");expect(f.patches).toBe(0);
 });
 it("fails closed on a different exact-model review",async()=>{
  const f=fixture();f.spec.verified_model="Blackmagic Pocket Cinema Camera 6K Pro";
  await expect(invoke(f)).rejects.toThrow("identity");expect(f.patches).toBe(0);
 });
});
