import { z } from "zod";
import { RENTER_BOT_INTENTS, CONVERSATION_STAGES } from "../../convex/lib/renter_bot_intents";

export const RENTER_BOT_OUTPUT_SCHEMA = z.object({
  draft: z.string().describe("Renter-facing reply. Empty when needs_human=true."),
  intent: z.enum(RENTER_BOT_INTENTS),
  conversation_stage: z.enum(CONVERSATION_STAGES),
  red_flags: z.array(z.string()),
  factsClaimed: z
    .array(
      z.object({
        kind: z.enum(["price", "availability", "date", "item_included", "technical_spec", "catalogue_match", "quote_readiness", "rule"]),
        value: z.string(),
        sourceTool: z.string(),
        sourceCallId: z.string(),
      }),
    )
    .describe("Every load-bearing factual claim in the draft, with the tool call that produced it."),
  needs_human: z.boolean(),
  needs_human_reason: z.string().optional(),
});

export type RenterBotOutput = z.infer<typeof RENTER_BOT_OUTPUT_SCHEMA>;

/** Validate the model envelope, not just JSON syntax. No text-only approval:
 * malformed output retains no attested stage, intent or escalation decision. */
export function parseRenterBotOutput(text: string): RenterBotOutput | null {
 try {
  let json=text.trim();
  const fence=json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence)json=fence[1].trim();
  const first=json.indexOf("{"),last=json.lastIndexOf("}");
  if(first<0||last<=first)return null;
  const parsed=RENTER_BOT_OUTPUT_SCHEMA.safeParse(JSON.parse(json.slice(first,last+1)));
  if(!parsed.success||!parsed.data.needs_human&&!parsed.data.draft.trim())return null;
  return parsed.data;
 }catch{return null;}
}
