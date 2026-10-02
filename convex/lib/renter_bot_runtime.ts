/** Daniel's written instruction, 2 October 2026: develop in the Lab; never
 * activate the audited bot in real Hygglo chats without explicit written
 * consent. Deployment approval and a verified renter are not rollout consent.
 * Keep the engine shared; activation changes this boundary, not its logic. */
export const RENTER_BOT_LIVE_CHAT_AUTHORIZED = false;
export function renterBotRuntimeAllowed(threadId: string) {
  return threadId.startsWith("__probe__") || RENTER_BOT_LIVE_CHAT_AUTHORIZED;
}
