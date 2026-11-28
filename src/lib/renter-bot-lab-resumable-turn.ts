import { isFailedLabReply } from "../../convex/lib/canonical_generation_error";

export type LabTranscriptForRecovery = {
  messages?: readonly { message_id: string; sender: string; text: string }[];
  turns?: readonly {
    turn_id: string;
    renter_message_id: string;
    status: string;
    updated_at: number;
    run_id?: string;
  }[];
  runs?: readonly {
    _id: string;
    generation_status?: string;
    overall_status?: string;
    draft_text?: string;
    rubric_results?: readonly {category?:string;status?:string}[];
  }[];
};

/** Recover only the newest unfinished server turn; never invent a new message
 * identity when the Lab page reloads after a timeout or generation failure. */
export function resumableLabTurn(transcript: LabTranscriptForRecovery | null | undefined) {
  if (!transcript?.turns?.length) return null;
  const latest = transcript.turns.reduce((selected, turn) =>
    turn.updated_at > selected.updated_at ? turn : selected,
  );
  const savedRun=latest.run_id?transcript.runs?.find(run=>run._id===latest.run_id):undefined;
  const failedCompleteRun=latest.status==="complete"&&isFailedLabReply(savedRun);
  if (latest.status !== "failed" && latest.status !== "running" && !failedCompleteRun) return null;
  const renterMessage = transcript.messages?.find((message) =>
    message.message_id === latest.renter_message_id && message.sender === "renter",
  );
  if (!renterMessage) return null;
  return {
    turnId: latest.turn_id,
    text: renterMessage.text,
    status: failedCompleteRun?"failed":latest.status,
    updatedAt: latest.updated_at,
  };
}
