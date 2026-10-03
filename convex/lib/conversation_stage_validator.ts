import { v } from "convex/values";
import { CONVERSATION_STAGES } from "./renter_bot_intents";
/** One vocabulary for structured model output, Native writes and storage. */
export const conversationStageValidator=v.union(...CONVERSATION_STAGES.map(stage=>v.literal(stage)));
