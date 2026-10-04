import { describe, expect, it } from "vitest";
import { renterCameraIdentities, unsupportedRenterCameraClaims as check } from "./renter_camera_identity";
import { guardDraft } from "./draft_guard";
import { scoreDraft } from "./renter_bot_rubric";

describe("renter camera identity provenance", () => {
  it("rejects both the saved instruction and the saved presupposing question", () => {
    const renter = ["I collected this TTArtisan 11mm Sony E lens. How do I turn autofocus on?"];
    expect(check("On your Sony body, turn on Focus Peaking.", renter)).toHaveLength(1);
    expect(check("Which Sony body are you shooting with?", renter)).toHaveLength(1);
    expect(check("Which camera body are you using?", renter)).toEqual([]);
  });
  it("supports an explicit self-described body, but not another model", () => {
    const renter = ["I'm shooting with a Sony FX3."];
    expect(check("On your Sony body, focus manually.", renter)).toEqual([]);
    expect(check("Your Sony FX3 camera has a focus ring.", renter)).toEqual([]);
    expect(check("Which FX3 camera are you using?", renter)).toEqual([]);
    expect(check("Which FX30 camera are you using?", renter)).toHaveLength(1);
    expect(check("Your Sony FX30 camera has a focus ring.", renter)).toHaveLength(1);
  });
  it("does not turn a brand into a model", () => {
    expect(check("Your Sony FX3 camera is ready.", ["I use a Sony body."])).toHaveLength(1);
  });
  it("uses the latest explicit correction, retaining it through unrelated turns", () => {
    const messages = ["My Sony body is ready.", "Actually my camera is a Canon R5.", "How do I focus the lens?"];
    expect(renterCameraIdentities(messages)).toEqual(["Canon R5"]);
    expect(check("Which Sony body are you using?", messages)).toHaveLength(1);
    expect(check("On your Canon body, focus manually.", messages)).toEqual([]);
  });
  it("does not accept hypothetical camera questions or lens/adapter use as identity", () => {
    for (const text of ["Could I use a Sony body?", "If I use a Sony FX3, will it fit?", "I'm using a Sony E lens.", "I use a Sony E mount adapter.", "I don't use a Sony body."]) {
      expect(check("Which Sony body are you using?", [text])).toHaveLength(1);
    }
  });
  it("keeps neutral setup questions and conditional suggestions answerable", () => {
    expect(check("Which current camera body do you use? If you use a Sony body, check its manual.", [])).toEqual([]);
  });
  it("accepts a stated camera followed by a support question", () => {
    expect(check("Which Sony body are you using?", ["I'm using a Sony FX3, how do I focus?"])).toEqual([]);
    expect(check("Which Sony body are you using?", ["Can I use a Sony FX3?"])).toHaveLength(1);
  });
  it("preserves two explicitly used bodies without promoting their lens", () => {
    const messages=["I'm using a Sony FX3 and a Canon R5 and a Sony E lens."];
    expect(renterCameraIdentities(messages)).toEqual(["Sony FX3","Canon R5"]);
    expect(check("On your Sony body, focus manually. Which Canon camera do you use?",messages)).toEqual([]);
  });
  it("generation and grading reject the actual saved assumption without borrowing owner prose", () => {
    const guard = guardDraft("Which Sony body are you shooting with?", {
      history:[{role:"owner",content:"On your Sony body, enable peaking."}],
      lastRenterMessage:"I collected the Sony E lens. How do I focus?",
    });
    expect(guard.flags).toContainEqual(expect.objectContaining({type:"RENTER_CAMERA_IDENTITY_UNVERIFIED",severity:"high",action:"flagged"}));
    const score = scoreDraft({accountSlug:"leo",draftText:guard.text,productionFlags:guard.flags});
    expect(score.overall_status).toBe("fail");
    expect(score.results).toContainEqual(expect.objectContaining({category:"renter_camera_identity",status:"fail"}));
  });
});
