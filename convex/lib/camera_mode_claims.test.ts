import { describe, expect, it } from "vitest";
import { unsupportedBuiltInNDClaims, unsupportedCameraModeClaims, type CameraEvidence } from "./camera_mode_claims";
import { guardDraft } from "./draft_guard";
import type { RecordingMode } from "./camera_requirements";
const mode = (fps: number, format: "full_frame" | "aps_c", width: boolean): RecordingMode => ({ resolution: "uhd_4k", nominal_fps: [fps], capture_format: format, full_width: width, internal: true, conditions: [], verified_model: "model", source_url: "https://manufacturer.example/mode", verified_at: 1 });
const evidence: CameraEvidence[] = [
  { names: ["Sony A7 V", "A7V"], capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", internal_4k: true, recording_modes: [mode(60, "full_frame", true), mode(120, "aps_c", false)] } },
  { names: ["Sony FX3", "FX3"], capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", internal_4k: true, recording_modes: [mode(60, "full_frame", true), mode(120, "full_frame", false)] } },
];
describe("recording mode claims use exact model and capture area", () => {
  it("requires reviewed proof for a generic 4K recording assertion without a frame rate",()=>{
    const basic=[{...evidence[1],capabilities:{...evidence[1].capabilities,recording_modes:[]}}];
    expect(unsupportedCameraModeClaims("Canon R5 records 4K internally.",basic)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records 4K internally.",basic)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records 4K externally.",basic)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records uncropped 4K internally.",basic)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records DCI 4K internally.",basic)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records 4K60p internally.",basic)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records 4K internally.",[{...basic[0],capabilities:{...basic[0].capabilities,internal_4k:false}}])).toHaveLength(1);
    const guard=guardDraft("Canon R5 records 4K internally.",{history:[],lastRenterMessage:"Does it record 4K?",cameraEvidence:basic});
    expect(guard.flags.some(f=>f.type==="CAMERA_MODE_HALLUCINATION")).toBe(true);
  });
  it("does not treat a model identity, question, requirement or accessory as a generic recording promise",()=>{
    for(const text of ["Does Canon R5 record 4K internally?","I'll check whether Canon R5 records 4K internally.","You need 4K recording for this shoot.","The Sony FX3 kit includes a 4K monitor."])
      expect(unsupportedCameraModeClaims(text,evidence)).toEqual([]);
    const named=[{...evidence[1],names:["Blackmagic Pocket Cinema Camera 4K"],capabilities:{...evidence[1].capabilities,internal_4k:false,recording_modes:[]}}];
    expect(unsupportedCameraModeClaims("I have the Blackmagic Pocket Cinema Camera 4K.",named)).toEqual([]);
  });
  it("blocks the actual misleading A7 V full-frame 4K120 recommendation", () => {
    expect(unsupportedCameraModeClaims("Sony A7 V: Records internally up to 4K 120p on a full-frame sensor. 3-day total is £110.", evidence)).toHaveLength(1);
  });
  it("permits cropped A7 V 4K120 and qualified full-frame 4K60", () => {
    expect(unsupportedCameraModeClaims("Sony A7 V records 4K120p in APS-C/Super 35 mode. It can do full-frame 4K60p using the required angle-of-view priority setting.", evidence)).toEqual([]);
  });
  it("distinguishes full-frame FX3 4K120 from an uncropped promise", () => {
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p with a narrower angle of view.", evidence)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records uncropped full-width 4K120p.", evidence)).toHaveLength(1);
  });
  it("does not let one model's mode evidence qualify another", () => {
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p. Sony A7 V also records full-frame 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("An unknown body records uncropped 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p. Canon C70 also records full-frame 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony A7 V cannot record full-frame 4K120p, but Sony FX3 records full-frame 4K120p with a narrower angle of view.", evidence)).toEqual([]);
  });
  it("keeps roman-numeral model identities separate", () => {
    const identities = [
      { ...evidence[1], names: ["Sony A7 III"] },
      { ...evidence[0], names: ["Sony A7 II"], capabilities: { ...evidence[0].capabilities, recording_modes: [] } },
    ];
    expect(unsupportedCameraModeClaims("Sony A7 III records full-frame 4K120p.", identities)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony A7 II records full-frame 4K120p.", identities)).toHaveLength(1);
  });
  it("permits honest negative/uncertain mode statements", () => {
    for (const text of ["Sony A7 V cannot record uncropped full-frame 4K120p.", "I'll check whether that unknown body records 4K120p.", "Neither the FX3 nor the A7V meets internal UHD 4K120p with full sensor width.", "I don't stock any Sony E-mount body that records completely uncropped, full-width 4K at 120fps internally."]) {
      expect(unsupportedCameraModeClaims(text, evidence)).toEqual([]);
    }
  });
  it("preserves the actual canonical requirement-review reply without attesting its mode", () => {
    expect(unsupportedCameraModeClaims("Hey! I'm checking my owned Sony E-mount full-frame cameras, including the FX3, A7 III, and A7 V, to verify exact support for uncropped internal DCI 4K at 60fps before quoting. Once that specification is confirmed, I'll share the verified camera option and exact two-day price for 20–21 October.", evidence)).toEqual([]);
    const reply = "Hi! The Canon R5 kit isn't available for 20–21 October. For a Sony E-mount full-frame camera recording uncropped internal DCI 4K at 60fps, I'm checking the exact recording specs across my bodies (like the Sony FX3, A7 V, and A7 III) to ensure I match your exact requirements before confirming the option and quoting the 2-day price.";
    expect(unsupportedCameraModeClaims(reply, evidence)).toEqual([]);
    const result = guardDraft(reply, { history: [], lastRenterMessage: "I need uncropped internal DCI 4K60fps", cameraEvidence: evidence });
    expect(result.flags.filter(f => f.type === "CAMERA_MODE_HALLUCINATION")).toEqual([]);
    expect(unsupportedCameraModeClaims("I'm checking whether Sony FX3 records uncropped DCI 4K60fps.", evidence)).toEqual([]);
    expect(unsupportedCameraModeClaims("Hi! I'm checking the exact recording specifications across my Sony full-frame E-mount cameras (including the FX3, A7 III, and A7 V) to verify which model meets your requirement for uncropped internal DCI 4K at 60fps. Once that capability is verified, I can give you the exact camera recommendation and the 2-day price for 20–21 October.", evidence)).toEqual([]);
  });
  it("does not let a later review predicate excuse a body assertion or separate promise", () => {
    for (const text of [
      "For Sony FX3 recording uncropped DCI 4K60fps, I'm checking the price.",
      "I'm checking the price (Sony FX3 records uncropped DCI 4K60fps).",
      "I'm checking the price (including Sony FX3), it records uncropped DCI 4K60fps.",
      "For a camera that records uncropped DCI 4K60fps, I can offer Sony FX3.",
      "For a camera recording uncropped DCI 4K60fps, I'm checking the specs, but Sony FX3 records uncropped DCI 4K60fps.",
      "For a camera recording uncropped DCI 4K60fps, I'm checking the specs. Sony FX3 records uncropped DCI 4K60fps.",
    ]) expect(unsupportedCameraModeClaims(text, evidence).length).toBeGreaterThan(0);
  });
  it("preserves the actual live cropped-mode explanations and lower-FPS compromise", () => {
    for (const text of [
      "Sony A7 V won't meet that requirement—internal 4K at 120fps requires APS-C / Super 35 mode (its full-frame 4K tops out at 60fps).",
      "The FX3 records internal 4K 120fps in full-frame mode rather than APS-C/Super 35, though its angle of view is narrower.",
      "Sony A7 V can shoot uncropped, full-width UHD 4K internally up to 60p (with APS-C/S35 shooting off; set angle-of-view Priority On).",
    ]) expect(unsupportedCameraModeClaims(text, evidence)).toEqual([]);
  });
  it("blocks a positive promise after a conditional clause", () => {
    expect(unsupportedCameraModeClaims("If you need 4K120p, Sony A7 V records uncropped full-frame 4K120p.", evidence)).toHaveLength(1);
  });
  it("does not use a UHD review to attest explicit DCI, or vice versa",()=>{
    const dci=[{...evidence[1],capabilities:{...evidence[1].capabilities,recording_modes:[{...mode(60,"full_frame",true),resolution:"dci_4k" as const}]}}];
    expect(unsupportedCameraModeClaims("Sony FX3 records full-width 4K60p.",dci)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records DCI 4K.",dci)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records DCI 4K.",evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 cannot record DCI 4K.",evidence)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 is an option. Do you need DCI 4K?",evidence)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records UHD 4K.",dci)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-width DCI 4K60p.",dci)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-width UHD 4K60p.",dci)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-width DCI 4K60p.",evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-width UHD and DCI 4K60p.",evidence)).toHaveLength(1);
    const guard=guardDraft("Sony FX3 records full-width DCI 4K60p.",{history:[],lastRenterMessage:"I need DCI 4K60p",cameraEvidence:evidence});
    expect(guard.flags).toContainEqual(expect.objectContaining({type:"CAMERA_MODE_HALLUCINATION",severity:"critical"}));
  });
  it("reaches the real guard as an unresolved critical review flag", () => {
    const result = guardDraft("Sony A7 V records uncropped full-frame 4K120p.", { history: [], lastRenterMessage: "I need uncropped 4K120p", cameraEvidence: evidence });
    expect(result.flags).toContainEqual(expect.objectContaining({ type: "CAMERA_MODE_HALLUCINATION", severity: "critical", action: "flagged" }));
  });
});

describe("reviewed intrinsic ND rather than physical accessories", () => {
  const ff = { names: ["BMPCC 6K Full Frame", "Blackmagic 6K Full Frame"], capabilities: { role: "interchangeable_lens" as const, sensor_format: "full_frame" as const, internal_4k: true, built_in_nd: false } };
  const pro = { names: ["BMPCC 6K Pro", "Blackmagic 6K Pro"], capabilities: { ...ff.capabilities, sensor_format: "super35" as const, built_in_nd: true } };
  it("accepts a named Pro followed by a truthful intrinsic feature parenthesis", () => {
    expect(unsupportedBuiltInNDClaims("Blackmagic 6K Pro is available. It comes with batteries (Super 35 sensor, native EF mount, built-in ND filters).", [ff, pro], ["BMPCC 6K Full Frame"])).toEqual([]);
  });
  it("blocks wrong or unknown body features and a false denial", () => {
    expect(unsupportedBuiltInNDClaims("Blackmagic 6K Full Frame has built-in ND filters.", [ff, pro])).toHaveLength(1);
    expect(unsupportedBuiltInNDClaims("Blackmagic 6K Pro has no built-in ND filters.", [ff, pro])).toHaveLength(1);
    expect(unsupportedBuiltInNDClaims("Canon C70 has built-in ND filters.", [ff, pro])).toHaveLength(1);
  });
  it("uses the actual selected request for a generic initial feature reference", () => {
    expect(unsupportedBuiltInNDClaims("It has built-in ND filters.", [ff, pro], ["BMPCC 6K Pro"])).toEqual([]);
    expect(unsupportedBuiltInNDClaims("It has built-in ND filters.", [ff, pro], ["BMPCC 6K Full Frame"])).toHaveLength(1);
  });
});


describe("ND stock declines are not camera feature assertions",()=>{
  const ff={names:["BMPCC 6K Full Frame","Blackmagic 6K Full Frame"],capabilities:{role:"interchangeable_lens" as const,sensor_format:"full_frame" as const,internal_4k:true,built_in_nd:false}};
  const pro={names:["BMPCC 6K Pro","Blackmagic 6K Pro"],capabilities:{role:"interchangeable_lens" as const,sensor_format:"super35" as const,internal_4k:true,built_in_nd:true}};
  it("preserves the actual additional-camera decline regardless of prior subject",()=>{
    for(const initial of [[],["BMPCC 6K Pro"],["BMPCC 6K Full Frame"]])
      expect(unsupportedBuiltInNDClaims("I don't have another cinema camera with built-in ND available alongside your current booking.",[ff,pro],initial)).toEqual([]);
    expect(unsupportedBuiltInNDClaims("No additional bodies with internal ND are available.",[ff,pro])).toEqual([]);
  });
  it("still blocks named incorrect and unknown features after a generic decline",()=>{
    expect(unsupportedBuiltInNDClaims("I don't have another camera with built-in ND available. Blackmagic 6K Full Frame has built-in ND.",[ff,pro])).toHaveLength(1);
    expect(unsupportedBuiltInNDClaims("I don't have Canon C70 with built-in ND available.",[ff,pro])).toHaveLength(1);
    expect(unsupportedBuiltInNDClaims("Blackmagic 6K Pro has no internal ND.",[ff,pro])).toHaveLength(1);
  });
});

describe("fronted feature modifiers retain the following camera subject",()=>{
 const cameras:CameraEvidence[]=[
  {names:["BMPCC 6K Full Frame"],capabilities:{...evidence[0].capabilities,built_in_nd:false}},
  {names:["BMPCC 6K Pro"],capabilities:{...evidence[0].capabilities,built_in_nd:true}}];
 const check=(text:string)=>unsupportedBuiltInNDClaims(text,cameras,["BMPCC 6K Full Frame"]);
 it("binds the actual fronted ND recommendation to Pro",()=>{
  expect(check("As a cheaper body-only alternative with built-in ND, I recommend the Blackmagic Pocket Cinema Camera 6K Pro (BMPCC 6K Pro).")).toEqual([]);
 });
 it("does not borrow another camera's evidence across independent assertions",()=>{
  for(const text of ["As BMPCC 6K Full Frame with built-in ND, I recommend BMPCC 6K Pro.","BMPCC 6K Full Frame has built-in ND, BMPCC 6K Pro is cheaper.","As a cheaper body-only alternative with built-in ND, I recommend BMPCC 6K Full Frame.","As a cheaper body-only alternative with built-in ND, I recommend Canon C70.","BMPCC 6K Full Frame has built-in ND, but BMPCC 6K Pro has built-in ND."])
   expect(check(text),text).not.toEqual([]);
 });
});


it("requires the asserted recording location rather than borrowing external mode proof for internal recording",()=>{
 const external:CameraEvidence[]=[{names:["Sony FX3"],capabilities:{...evidence[1].capabilities,recording_modes:[{...mode(60,"full_frame",true),internal:false}]}}];
 expect(unsupportedCameraModeClaims("Sony FX3 records UHD 4K60p externally.",external)).toEqual([]);
 expect(unsupportedCameraModeClaims("Sony FX3 records UHD 4K60p internally.",external)).toHaveLength(1);
 expect(unsupportedCameraModeClaims("Sony FX3 supports internal and external UHD 4K60p.",external)).toHaveLength(1);
 const both=[{...external[0],capabilities:{...external[0].capabilities,recording_modes:[...external[0].capabilities.recording_modes!,mode(60,"full_frame",true)]}}];
 expect(unsupportedCameraModeClaims("Sony FX3 supports internal and external UHD 4K60p.",both)).toEqual([]);
 expect(unsupportedCameraModeClaims("Sony FX3 records UHD 4K60p externally, not internally.",external)).toEqual([]);
});

it("does not confuse external supplied media or accessories with an external recording pipeline",()=>{
 const internal=[evidence[1]];
 for(const text of ["Sony FX3 records UHD 4K60p with an external microphone.","Sony FX3 records UHD 4K60p to an external SSD."])
  expect(unsupportedCameraModeClaims(text,internal)).toEqual([]);
 expect(unsupportedCameraModeClaims("Sony FX3 records external UHD 4K60p using a recorder.",internal)).toHaveLength(1);
});


it("separates current camera identity labels from recording capability claims",()=>{
 const camera:CameraEvidence={names:["BMPCC 6K", "BMPCC 6K Full Frame","Blackmagic Cinema Camera 6K"],capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",internal_4k:true,recording_modes:[{...mode(60,"full_frame",false),resolution:"dci_4k",capture_format:undefined}]}};
 for(const name of ["BMPCC 6K Full Frame","BMPCC 6K Full-Frame","Blackmagic Cinema Camera 6K"]){
  expect(unsupportedCameraModeClaims(`${name} records DCI 4K60p internally.`,[camera])).toEqual([]);
  expect(unsupportedCameraModeClaims(`${name} records full-frame DCI 4K60p internally.`,[camera])).toHaveLength(1);
  expect(unsupportedCameraModeClaims(`${name} records uncropped DCI 4K60p internally.`,[camera])).toHaveLength(1);
  expect(unsupportedCameraModeClaims(`${name} records DCI 4K120p internally.`,[camera])).toHaveLength(1);
  expect(unsupportedCameraModeClaims(`${name} records DCI 4K60p externally.`,[camera])).toHaveLength(1);
 }
 const labelled={...camera,names:["DCI 4K Full Frame Camera"]};
 expect(unsupportedCameraModeClaims("DCI 4K Full Frame Camera is the camera name.",[labelled])).toEqual([]);
 expect(unsupportedCameraModeClaims("DCI 4K Full Frame Camera records UHD 4K60p.",[labelled])).toHaveLength(1);
 expect(unsupportedCameraModeClaims("DCI 4K Full Frame Camera records DCI 4K60p internally.",[labelled])).toEqual([]);
 expect(unsupportedCameraModeClaims("BMPCC 6K Full Frame records DCI 4K60p internally. It records full-frame DCI 4K60p internally.",[camera])).toHaveLength(1);
});
