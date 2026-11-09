export type RenterBotDraftApiAuthMode = "service" | "hosted-lab";

type RenterBotDraftApiAuthEnvironment = {
  RENTER_BOT_API_SECRET?: string;
  RENTER_BOT_LAB_API_SECRET?: string;
  RENTER_BOT_LAB_DEPLOYMENT?: string;
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED?: string;
};

export function renterBotDraftApiAuthMode(
  authorization: string | null,
  env: RenterBotDraftApiAuthEnvironment = process.env as RenterBotDraftApiAuthEnvironment,
): RenterBotDraftApiAuthMode | null {
  if (env.RENTER_BOT_API_SECRET && authorization === `Bearer ${env.RENTER_BOT_API_SECRET}`) return "service";
  if (env.RENTER_BOT_LAB_DEPLOYMENT === "hosted" && env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED === "false" &&
      env.RENTER_BOT_LAB_API_SECRET && authorization === `Bearer ${env.RENTER_BOT_LAB_API_SECRET}`) return "hosted-lab";
  return null;
}

export function hostedLabDraftApiAuthAllowed(mode: RenterBotDraftApiAuthMode, threadId: string): boolean {
  return mode !== "hosted-lab" || threadId.startsWith("__probe__");
}
