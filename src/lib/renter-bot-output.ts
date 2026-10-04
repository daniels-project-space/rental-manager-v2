import { z } from "zod";
import { RENTER_BOT_INTENTS, CONVERSATION_STAGES } from "../../convex/lib/renter_bot_intents";

export const RENTER_BOT_OUTPUT_SCHEMA = z.object({
  draft: z.string().describe("Renter-facing reply when reply_parts is omitted. Empty when reply_parts is used or needs_human=true."),
  reply_parts: z.array(z.discriminatedUnion("type",[
    z.object({type:z.literal("text"),text:z.string()}),
    z.object({type:z.literal("quote"),quote_key:z.string().regex(/^inquiry_[a-f0-9]{32}$/)}),
  ])).min(1).max(12).optional().describe("For Native inquiry quotes, use text parts without money and quote parts selecting renter_quote.quote_key from check_basket_availability. Leave draft empty; the server renders the verified quote. Omit for replies without a Native inquiry quote."),
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

export function validateRenterBotOutput(value: unknown): RenterBotOutput | null {
 const parsed=RENTER_BOT_OUTPUT_SCHEMA.safeParse(value);
 if(!parsed.success||!parsed.data.needs_human&&!parsed.data.draft.trim()&&!parsed.data.reply_parts?.some(p=>p.type==="quote"||p.text.trim()))return null;
 return parsed.data;
}

/** Validate the model envelope, not just JSON syntax. No text-only approval:
 * malformed output retains no attested stage, intent or escalation decision. */
export function parseRenterBotOutput(text: string): RenterBotOutput | null {
 try {
  let json=text.trim();
  const fence=json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence)json=fence[1].trim();
  const first=json.indexOf("{"),last=json.lastIndexOf("}");
  if(first<0||last<=first)return null;
  return validateRenterBotOutput(JSON.parse(json.slice(first,last+1)));
 }catch{return null;}
}
