/**
 * WallE — shared types for the dashboard assistant widget.
 *
 * Mood is the high-level emotional state of the orb. It is derived in
 * WallE.tsx from chat phase, live signal severity, and idle timeouts,
 * then passed down to WallEOrb which maps it to visual props.
 */

export type Mood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'alert'
  | 'celebrating';

export interface MoodVisual {
  /** Darker color of the watercolor ramp (uColor1). Hex with leading #. */
  primary: string;
  /** Lighter color of the watercolor ramp (uColor2). Hex with leading #. */
  secondary: string;
  /** Multiplier for animation speed and ripple frequency (1.0 = baseline). */
  speed: number;
  /** Multiplier for input-volume amplitude (0..1). Drives oval/ring expansion. */
  intensity: number;
}

/**
 * Live dashboard signal that feeds the WallE mood reducer.
 *
 * 'alert' lights up the orb red (conflicts/double-bookings).
 * 'warn' is amber (overdue returns, large util drops).
 * 'info' is blue (revenue up, util spike, fresh pending review).
 */
export type SignalSeverity = 'info' | 'warn' | 'alert';

export interface Signal {
  id: string;
  kind:
    | 'conflict'
    | 'pending'
    | 'due_return'
    | 'revenue_up'
    | 'revenue_down'
    | 'utilization_spike'
    | 'utilization_drop';
  label: string;
  severity: SignalSeverity;
  ts: number;
}

/**
 * Phase 5 — chat persistence shape. One row per user or assistant turn.
 * `ts` is epoch ms for ordering.
 */
export interface WallEChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/**
 * Phase 5 — chat-derived high-level state used by the parent to drive
 * the orb mood. 'listening' = textarea focused with content.
 * 'thinking' = streaming response in flight. 'idle' = neither.
 */
export type WallEChatState = 'idle' | 'listening' | 'thinking';
