/**
 * WallE mood → visual mapping.
 *
 * Colors picked to harmonize with the rental-manager-v2 dark theme
 * (body #070910, card rgba(14,17,28,0.85), accents green/amber/blue/purple/red
 * defined in src/app/globals.css @theme tokens).
 *
 * The orb's fragment shader applies a 4-stop color ramp
 * [black → primary → secondary → white] so picking two harmonious hues that
 * sit one step apart in luminance produces the watercolor look.
 */

import type { Mood, MoodVisual, Signal } from './walle.types';

export const MOOD_VISUALS: Record<Mood, MoodVisual> = {
  // Calm, drifting — default resting state. Matches design-token --accent-blue.
  idle: {
    primary: '#3b82f6',   // blue-500
    secondary: '#22d3ee', // cyan-400 / teal
    speed: 1.0,
    intensity: 0.35,
  },
  // Active microphone — brighter, faster ripple.
  listening: {
    primary: '#e4e6eb',   // primary text / white
    secondary: '#60a5fa', // blue-400
    speed: 1.4,
    intensity: 0.7,
  },
  // Reasoning — slow purple swirl.
  thinking: {
    primary: '#7c3aed',   // violet-600 / --accent-purple
    secondary: '#a78bfa', // violet-400
    speed: 0.8,
    intensity: 0.5,
  },
  // Urgent — red pulse for double-bookings / conflicts.
  alert: {
    primary: '#dc2626',   // red-600 / --accent-red
    secondary: '#f87171', // red-400
    speed: 1.6,
    intensity: 0.85,
  },
  // Celebration — green bloom for confirmed bookings / milestones.
  celebrating: {
    primary: '#16a34a',   // green-600 / --accent-green
    secondary: '#4ade80', // green-400
    speed: 1.3,
    intensity: 0.75,
  },
};

/**
 * Map our high-level Mood to the ElevenLabs Orb's agentState prop.
 * Orb agentState is one of: null | 'thinking' | 'listening' | 'talking'.
 * Most of our moods are emotional flavor on top — they all behave like
 * a soft "talking" idle except the listening/thinking moods which align.
 */
export function moodToAgentState(
  mood: Mood,
): null | 'thinking' | 'listening' | 'talking' {
  switch (mood) {
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'alert':
    case 'celebrating':
      return 'talking';
    case 'idle':
    default:
      return null;
  }
}

/**
 * Derive the WallE mood from live signals + chat state + idle time.
 *
 * Priority (highest first):
 *   1. Any 'alert'-severity signal (conflicts) → 'alert' (red).
 *   2. chatState 'thinking' → 'thinking' (violet swirl).
 *   3. chatState 'listening' → 'listening' (mic active).
 *   4. Recent revenue_up / utilization_spike (< 60s old) → 'celebrating'.
 *   5. Otherwise → 'idle'.
 *
 * idleSinceMs is currently used only to gate the joke loop (Phase 7);
 * mood stays 'idle' regardless of how long we've been idle.
 */
export function deriveMood(
  signals: Signal[],
  opts: { idleSinceMs: number; chatState: 'idle' | 'listening' | 'thinking' },
): Mood {
  // 1. Alerts always win — double-booking outranks everything.
  if (signals.some((s) => s.severity === 'alert')) return 'alert';

  // 2-3. Chat-driven moods.
  if (opts.chatState === 'thinking') return 'thinking';
  if (opts.chatState === 'listening') return 'listening';

  // 4. Recent good news — bloom green for a minute.
  const now = Date.now();
  const sixtySecAgo = now - 60_000;
  const celebrating = signals.some(
    (s) =>
      (s.kind === 'revenue_up' || s.kind === 'utilization_spike') &&
      s.ts >= sixtySecAgo,
  );
  if (celebrating) return 'celebrating';

  // 5. Default — calm drift. (Joke loop is a separate concern, see Phase 7.)
  void opts.idleSinceMs;
  return 'idle';
}
