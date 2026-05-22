/**
 * WallESpeechBubble — framer-motion bubble with SVG tail.
 *
 * Renders a rounded bubble with an SVG tail pointing at the character. The
 * tail orientation is chosen via `tailSide` (default "bottomLeft" → tail
 * points down-left toward WallE sitting at upper-left of the message stack).
 *
 * Enter/exit are handled via framer-motion variants; wrap calls in
 * <AnimatePresence> at the call site to drive exit anim on unmount.
 *
 * No internal timer — parent owns the lifecycle (latest assistant message id
 * is the only "should the bubble exist" signal).
 */
"use client";

import { motion } from "framer-motion";
import type { CSSProperties, ReactNode } from "react";

export type BubbleTone = "neutral" | "alert" | "celebrating" | "thinking";
export type TailSide = "bottomLeft" | "bottomRight" | "topLeft" | "left";

export interface WallESpeechBubbleProps {
  /** Bubble content — usually text but supports nodes (streaming dots). */
  children: ReactNode;
  /** Stable id so AnimatePresence keeps enter/exit in sync per message. */
  id?: string;
  /** Visual tone — drives border + soft glow. */
  tone?: BubbleTone;
  /** Where the tail points. Default "bottomLeft". */
  tailSide?: TailSide;
  /** Optional max width override. */
  maxWidth?: number | string;
  /** Optional extra className on root. */
  className?: string;
  /** Optional onClick (e.g. dismiss). */
  onClick?: () => void;
}

function toneStyles(tone: BubbleTone): {
  border: string;
  glow: string;
  bg: string;
  fg: string;
} {
  switch (tone) {
    case "alert":
      return {
        border: "rgba(248, 113, 113, 0.45)",
        glow: "0 8px 24px rgba(248, 113, 113, 0.18)",
        bg: "rgba(43, 16, 16, 0.92)",
        fg: "#fecaca",
      };
    case "celebrating":
      return {
        border: "rgba(74, 222, 128, 0.45)",
        glow: "0 8px 24px rgba(74, 222, 128, 0.18)",
        bg: "rgba(16, 43, 26, 0.92)",
        fg: "#bbf7d0",
      };
    case "thinking":
      return {
        border: "rgba(167, 139, 250, 0.45)",
        glow: "0 8px 24px rgba(167, 139, 250, 0.18)",
        bg: "rgba(30, 27, 58, 0.92)",
        fg: "#ddd6fe",
      };
    default:
      return {
        border: "rgba(142, 197, 255, 0.32)",
        glow: "0 10px 28px rgba(99, 102, 241, 0.18)",
        bg: "rgba(20, 24, 36, 0.94)",
        fg: "#e4e6eb",
      };
  }
}

export default function WallESpeechBubble({
  children,
  id,
  tone = "neutral",
  tailSide = "bottomLeft",
  maxWidth,
  className,
  onClick,
}: WallESpeechBubbleProps) {
  const s = toneStyles(tone);

  const rootStyle: CSSProperties = {
    background: s.bg,
    color: s.fg,
    border: `1px solid ${s.border}`,
    boxShadow: s.glow,
    maxWidth: maxWidth ?? "100%",
  };

  return (
    <motion.div
      key={id}
      layout
      onClick={onClick}
      className={[
        "relative inline-block rounded-2xl px-4 py-3 text-sm leading-snug whitespace-pre-wrap",
        className ?? "",
      ].join(" ")}
      style={rootStyle}
      initial={{ opacity: 0, scale: 0.9, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -4 }}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 28,
        mass: 0.6,
      }}
    >
      {children}
      <BubbleTail side={tailSide} fill={s.bg} stroke={s.border} />
    </motion.div>
  );
}

/* ── SVG tail — pointed triangle matching bubble fill/stroke ─────────── */
function BubbleTail({
  side,
  fill,
  stroke,
}: {
  side: TailSide;
  fill: string;
  stroke: string;
}) {
  const positions: Record<TailSide, CSSProperties> = {
    bottomLeft: {
      position: "absolute",
      bottom: -10,
      left: 18,
      width: 24,
      height: 14,
      transform: "rotate(0deg)",
    },
    bottomRight: {
      position: "absolute",
      bottom: -10,
      right: 18,
      width: 24,
      height: 14,
      transform: "scaleX(-1)",
    },
    topLeft: {
      position: "absolute",
      top: -10,
      left: 18,
      width: 24,
      height: 14,
      transform: "rotate(180deg)",
    },
    left: {
      position: "absolute",
      top: 12,
      left: -13,
      width: 16,
      height: 28,
      transform: "rotate(-90deg)",
    },
  };

  return (
    <svg
      viewBox="0 0 24 14"
      style={positions[side]}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M0,0 L24,0 L8,13 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* Cover the top stroke so the tail edge merges with the bubble border. */}
      <line x1="0" y1="0" x2="24" y2="0" stroke={fill} strokeWidth="2" />
    </svg>
  );
}
