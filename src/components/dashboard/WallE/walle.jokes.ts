/**
 * Phase 7 — WallE camera-gear joke seeds + idle timing constants.
 *
 * The seeds are short LLM prompts (NOT the jokes themselves) — the route
 * picks one and asks the model to write a fresh joke in WallE's dry,
 * camera-aware voice. Keeping seeds diverse prevents repetitive output.
 *
 * Pure module — safe to import from both the client and the server route.
 */

/** Pool of one-shot prompt seeds for joke generation. 14 entries. */
export const CAMERA_JOKE_SEEDS: string[] = [
  "Make a dry joke about renting a 70-200mm to a wedding photographer who arrives 15 minutes late.",
  "Write a pun about ND filters and personality.",
  "Quip about a customer asking if the rented prime lens has 'autozoom'.",
  "Camera-gear deadpan about insurance excess being heavier than the lens itself.",
  "Joke about a renter swearing the gimbal was 'already wobbly' on pickup.",
  "Dry observation about Hygglo reviews mentioning the lens cap before the optics.",
  "One-liner about a Sony body rental coming back with Canon fingerprints.",
  "Quick gag about a customer who thinks 'full frame' means it includes a tripod.",
  "Pun about back-focus and back-pain on long shoots.",
  "Wry remark about explaining to a renter that 'IBIS' is not an Egyptian bird.",
  "Joke about a videographer asking if the cage 'fits a mirrorless ego'.",
  "Camera-shop deadpan about lens hoods being the first thing renters lose.",
  "Pun involving aperture priority and indecision.",
  "Terse joke about a tripod being rented for a 'quick handheld shot'.",
];

/**
 * Picks one seed at random. Pure — uses Math.random so callable from any
 * runtime (route handler or component).
 */
export function pickJokeSeed(): string {
  const i = Math.floor(Math.random() * CAMERA_JOKE_SEEDS.length);
  return CAMERA_JOKE_SEEDS[i] ?? CAMERA_JOKE_SEEDS[0];
}

/** Idle threshold before the chat panel attempts a joke (2 minutes). */
export const JOKE_IDLE_AFTER_MS = 2 * 60 * 1000;
