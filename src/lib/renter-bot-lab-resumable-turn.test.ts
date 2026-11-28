import { describe, expect, it } from "vitest";
import { resumableLabTurn } from "./renter-bot-lab-resumable-turn";

describe("Lab turn recovery after reload", () => {
  it("restores the saved renter message and exact turn ID after a failed run", () => {
    expect(resumableLabTurn({
      messages: [{ message_id: "message-1", sender: "renter", text: "Can I collect in Shoreditch?" }],
      turns: [{ turn_id: "turn-12345678", renter_message_id: "message-1", status: "failed", updated_at: 10 }],
    })).toEqual({ turnId: "turn-12345678", text: "Can I collect in Shoreditch?", status: "failed", updatedAt: 10 });
  });

  it("does not restore an older failure after a newer turn completed", () => {
    expect(resumableLabTurn({
      messages: [
        { message_id: "message-1", sender: "renter", text: "First" },
        { message_id: "message-2", sender: "renter", text: "Second" },
      ],
      turns: [
        { turn_id: "turn-failed-1", renter_message_id: "message-1", status: "failed", updated_at: 10 },
        { turn_id: "turn-complete-2", renter_message_id: "message-2", status: "complete", updated_at: 20 },
      ],
    })).toBeNull();
  });

  it("recovers a legacy completed turn whose saved run failed without a reply", () => {
    expect(resumableLabTurn({
      messages:[{message_id:"message-1",sender:"renter",text:"Please add the gimbal."}],
      turns:[{turn_id:"turn-12345678",renter_message_id:"message-1",status:"complete",updated_at:10,run_id:"run-1"}],
      runs:[{_id:"run-1",generation_status:"complete",overall_status:"fail",draft_text:"",rubric_results:[{category:"generation_outcome",status:"fail"}]}],
    })).toEqual({turnId:"turn-12345678",text:"Please add the gimbal.",status:"failed",updatedAt:10});
  });

  it("does not reopen a deliberate no-reply owner handoff", () => {
    expect(resumableLabTurn({
      messages:[{message_id:"message-1",sender:"renter",text:"Can you check this?"}],
      turns:[{turn_id:"turn-12345678",renter_message_id:"message-1",status:"complete",updated_at:10,run_id:"run-1"}],
      runs:[{_id:"run-1",generation_status:"complete",overall_status:"flag",draft_text:"",rubric_results:[{category:"owner_review_completion",status:"flag"}]}],
    })).toBeNull();
  });

  it("keeps a current run bound to its original message", () => {
    expect(resumableLabTurn({
      messages: [{ message_id: "message-1", sender: "renter", text: "Retry me" }],
      turns: [{ turn_id: "turn-12345678", renter_message_id: "message-1", status: "running", updated_at: 10 }],
    })).toMatchObject({ turnId: "turn-12345678", text: "Retry me", status: "running" });
  });

  it("does not resume an orphaned turn without its persisted renter message", () => {
    expect(resumableLabTurn({
      messages: [],
      turns: [{ turn_id: "turn-12345678", renter_message_id: "message-1", status: "failed", updated_at: 10 }],
    })).toBeNull();
  });
});
