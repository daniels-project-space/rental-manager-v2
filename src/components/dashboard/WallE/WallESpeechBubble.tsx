/**
 * WallESpeechBubble — floating CSS speech bubble next to the character.
 *
 * Auto-fades in on mount, auto-dismisses after `autoDismissMs` (default 10s).
 * `onDismiss` fires once when the timer expires OR when the user clicks the
 * dismiss target, so the parent can clear its bubble state.
 *
 * The tail is a CSS triangle pinned to the lower-left edge so it points down
 * toward the character. The parent positions the bubble absolutely.
 */
"use client";

import { useEffect, useState } from "react";

export interface WallESpeechBubbleProps {
  text: string;
  /** Optional id — used as react key by the parent to re-mount on new lines. */
  id?: string;
  autoDismissMs?: number;
  onDismiss?: () => void;
  /** Tint for the bubble border / shadow ("alert" gets warm red, etc.). */
  tone?: "neutral" | "alert" | "celebrating";
}

export default function WallESpeechBubble({
  text,
  autoDismissMs = 10_000,
  onDismiss,
  tone = "neutral",
}: WallESpeechBubbleProps) {
  const [visible, setVisible] = useState(false);

  // Fade-in on mount.
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), 20);
    return () => window.clearTimeout(t);
  }, []);

  // Auto-dismiss.
  useEffect(() => {
    if (!autoDismissMs) return;
    const t = window.setTimeout(() => {
      setVisible(false);
      // Wait for fade-out then notify parent.
      window.setTimeout(() => onDismiss?.(), 220);
    }, autoDismissMs);
    return () => window.clearTimeout(t);
  }, [autoDismissMs, onDismiss]);

  const toneStyles = TONE_STYLES[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className="walle-bubble"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(6px)",
        transition: "opacity 200ms ease, transform 200ms ease",
        background: toneStyles.bg,
        border: `1px solid ${toneStyles.border}`,
        color: toneStyles.fg,
        boxShadow: toneStyles.shadow,
      }}
    >
      <p style={{ margin: 0, lineHeight: 1.35 }}>{text}</p>
      {/* Tail — pure CSS triangle pointing down-left toward the character */}
      <span
        aria-hidden="true"
        className="walle-bubble-tail"
        style={{
          background: toneStyles.bg,
          borderRight: `1px solid ${toneStyles.border}`,
          borderBottom: `1px solid ${toneStyles.border}`,
        }}
      />
      <style>{BUBBLE_CSS}</style>
    </div>
  );
}

const TONE_STYLES: Record<
  NonNullable<WallESpeechBubbleProps["tone"]>,
  { bg: string; border: string; fg: string; shadow: string }
> = {
  neutral: {
    bg: "rgba(20, 26, 38, 0.96)",
    border: "rgba(142, 197, 255, 0.4)",
    fg: "#e5e7eb",
    shadow: "0 8px 24px rgba(0,0,0,0.45), 0 0 18px rgba(142,197,255,0.18)",
  },
  alert: {
    bg: "rgba(40, 12, 12, 0.96)",
    border: "rgba(252, 165, 165, 0.55)",
    fg: "#fee2e2",
    shadow: "0 8px 24px rgba(0,0,0,0.5), 0 0 24px rgba(248,113,113,0.35)",
  },
  celebrating: {
    bg: "rgba(12, 30, 18, 0.96)",
    border: "rgba(134, 239, 172, 0.5)",
    fg: "#dcfce7",
    shadow: "0 8px 24px rgba(0,0,0,0.45), 0 0 22px rgba(74,222,128,0.3)",
  },
};

const BUBBLE_CSS = `
.walle-bubble {
  position: relative;
  max-width: 220px;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.005em;
  pointer-events: auto;
  will-change: opacity, transform;
}
.walle-bubble-tail {
  position: absolute;
  bottom: -7px;
  left: 28px;
  width: 12px;
  height: 12px;
  transform: rotate(45deg);
  border-bottom-right-radius: 3px;
}
`;
