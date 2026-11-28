export type RenterBotDraftApiAuthMode = "service" | "hosted-lab" | "local-lab";

type RenterBotDraftApiAuthEnvironment = {
  RENTER_BOT_API_SECRET?: string;
  RENTER_BOT_LAB_API_SECRET?: string;
  RENTER_BOT_LAB_DEPLOYMENT?: string;
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED?: string;
  NODE_ENV?: string;
};

export function renterBotDraftApiAuthMode(
  authorization: string | null,
  env: RenterBotDraftApiAuthEnvironment = process.env as RenterBotDraftApiAuthEnvironment,
  labRequest?: string | null,
): RenterBotDraftApiAuthMode | null {
  if (labRequest === "true") {
    if (env.RENTER_BOT_LAB_DEPLOYMENT === "hosted" && env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED === "false" &&
        env.RENTER_BOT_LAB_API_SECRET && authorization === `Bearer ${env.RENTER_BOT_LAB_API_SECRET}`) return "hosted-lab";
    if (env.NODE_ENV === "development" && env.RENTER_BOT_LAB_DEPLOYMENT === "local" &&
        env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED === "false" && env.RENTER_BOT_LAB_API_SECRET &&
        authorization === `Bearer ${env.RENTER_BOT_LAB_API_SECRET}`) return "local-lab";
    return null;
  }
  if (env.RENTER_BOT_API_SECRET && authorization === `Bearer ${env.RENTER_BOT_API_SECRET}`) return "service";
  if (env.RENTER_BOT_LAB_DEPLOYMENT === "hosted" && env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED === "false" &&
      env.RENTER_BOT_LAB_API_SECRET && authorization === `Bearer ${env.RENTER_BOT_LAB_API_SECRET}`) return "hosted-lab";
  return null;
}

export function hostedLabDraftApiAuthAllowed(mode: RenterBotDraftApiAuthMode, threadId: string): boolean {
  return (mode !== "hosted-lab" && mode !== "local-lab") || threadId.startsWith("__probe__");
}

/** Both isolated Lab auth lanes must use the Lab model credential and agent. */
export function renterBotDraftApiUsesLabAgent(mode: RenterBotDraftApiAuthMode): boolean {
  return mode === "hosted-lab" || mode === "local-lab";
}
