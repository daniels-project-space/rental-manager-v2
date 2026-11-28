type DraftEndpointEnv = {
  RENTER_BOT_LAB_API_BASE_URL?: string;
  RENTER_BOT_LAB_API_SECRET?: string;
  NOTIF_BASE_URL?: string;
  RENTER_BOT_API_SECRET?: string;
};

export function renterBotDraftEndpoint(threadId: string, env: DraftEndpointEnv) {
  const lab = threadId.startsWith("__probe__");
  const base = (lab ? env.RENTER_BOT_LAB_API_BASE_URL : env.NOTIF_BASE_URL)?.trim();
  const secret = (lab ? env.RENTER_BOT_LAB_API_SECRET : env.RENTER_BOT_API_SECRET)?.trim();
  if (!base || !secret) {
    throw new Error(lab
      ? "Isolated Lab draft endpoint or RENTER_BOT_LAB_API_SECRET is not configured"
      : "RENTER_BOT_API_SECRET is not configured");
  }

  let url: URL;
  try {
    url = new URL("/api/renter-bot-draft", base);
  } catch {
    throw new Error(lab ? "Invalid isolated Lab draft endpoint" : "Invalid renter-bot draft endpoint");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error(lab ? "Invalid isolated Lab draft endpoint" : "Invalid renter-bot draft endpoint");
  }
  return { url: url.toString(), authorization: `Bearer ${secret}`, lab };
}
