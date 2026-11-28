export const RENTER_BOT_LAB_SESSION_STORAGE_KEY = "renter-bot-lab-session-v1";

export interface RenterBotLabSessionContext {
  scenarioTitle: string;
  itemName: string;
  displayName: string;
  items: string[];
  startDate: string;
  endDate: string;
  initialBotMessage?: string;
  friendReference?: string;
}

export interface RenterBotLabSession {
  threadId: string;
  accountSlug: string;
  context: RenterBotLabSessionContext;
  sourceThreadId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLabThreadId(value: unknown): value is string {
  return typeof value === "string" && /^__probe__lab-[A-Za-z0-9_-]+$/.test(value);
}

function isSessionContext(value: unknown): value is RenterBotLabSessionContext {
  return isRecord(value) &&
    typeof value.scenarioTitle === "string" &&
    typeof value.itemName === "string" &&
    typeof value.displayName === "string" &&
    Array.isArray(value.items) && value.items.every((item) => typeof item === "string") &&
    typeof value.startDate === "string" &&
    typeof value.endDate === "string" &&
    (value.initialBotMessage === undefined || typeof value.initialBotMessage === "string") &&
    (value.friendReference === undefined || typeof value.friendReference === "string");
}

export function parseRenterBotLabSession(raw: string | null): RenterBotLabSession | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isLabThreadId(value.threadId) ||
        !["leo", "dbcinema", "diogo"].includes(String(value.accountSlug)) ||
        !isSessionContext(value.context) ||
        (value.sourceThreadId !== undefined && !isLabThreadId(value.sourceThreadId))) {
      return null;
    }
    return value as unknown as RenterBotLabSession;
  } catch {
    return null;
  }
}

export function serializeRenterBotLabSession(session: RenterBotLabSession): string {
  return JSON.stringify(session);
}
