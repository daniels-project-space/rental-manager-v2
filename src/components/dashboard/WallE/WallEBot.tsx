/**
 * WallEBot — animated robot character backed by a vendored dotLottie file.
 *
 * The previous hand-rolled SVG is gone. `robot.lottie` (vendored under
 * src/components/dashboard/WallE/character-vendor/ and served from
 * /public/walle-vendor/) is rendered by @lottiefiles/dotlottie-react — a real
 * skeletal animation with shading + secondary motion, ~25 KB on the wire.
 *
 * Mood → playback speed (via dotLottie.setSpeed):
 *   idle 1.0 · listening 1.15 · thinking 0.65 · alert 1.6 · celebrating 1.4
 *   `speaking` adds +0.2 on top.
 *
 * Idle micro-behaviors from useWalleIdle drive CSS transforms on the *frame*
 * wrapper (cursor-tracking parallax, head tilt, yawn squash, antenna twitch).
 * A separate eyelid overlay punches the blink — covers the goggle band for
 * ~140 ms so the user *sees* the bot blink even though the Lottie itself runs
 * its own ambient eye motion.
 */
"use client";

import { forwardRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";
import type { Mood } from "./walle.types";
import { useWalleIdle } from "./walle.idle";

export interface WallEBotProps {
  mood: Mood;
  /** Outer square edge length in px. Default fills its parent. */
  size?: number;
  /** Click handler — used by the parent to trigger narration. */
  onClick?: () => void;
  /** Aria label override (defaults reference mood). */
  ariaLabel?: string;
  /** When true the character is "speaking" → tiny lean-forward variant. */
  speaking?: boolean;
}

const MOOD_SPEED: Record<Mood, number> = {
  idle: 1.0,
  listening: 1.15,
  thinking: 0.65,
  alert: 1.6,
  celebrating: 1.4,
};

function effectiveSpeed(mood: Mood, speaking: boolean, yawning: boolean): number {
  let s = MOOD_SPEED[mood] ?? 1;
  if (speaking) s += 0.2;
  if (yawning) s *= 0.6;
  return Math.max(0.2, Math.min(2.5, s));
}

const WallEBot = forwardRef<HTMLButtonElement, WallEBotProps>(
  function WallEBot({ mood, size, onClick, ariaLabel, speaking = false }, ref) {
    const idle = useWalleIdle(mood);
    const [player, setPlayer] = useState<DotLottie | null>(null);

    // Drive playback speed from mood + speaking + yawn.
    useEffect(() => {
      if (!player) return;
      try {
        player.setSpeed(effectiveSpeed(mood, speaking, idle.yawn));
      } catch {
        /* player not yet ready — ignore */
      }
    }, [player, mood, speaking, idle.yawn]);

    // Alert mood: subtle shake via re-trigger key
    const shakeKey = mood === "alert" ? "shake" : "calm";

    const bodyVariant = speaking
      ? "speaking"
      : mood === "alert"
        ? "alert"
        : mood === "celebrating"
          ? "cheer"
          : idle.yawn
            ? "yawn"
            : "rest";

    // Parallax from cursor (subtle) + glance overrides.
    const glancePx = 6;
    const cursorPx = 3;
    const offsetX = idle.glanceLeft
      ? -glancePx
      : idle.glanceRight
        ? glancePx
        : idle.cursorX * cursorPx;
    const offsetY = idle.cursorY * 1.6;
    const headRotate = idle.headTilt ? 4 : idle.antennaTwitch ? -2 : 0;
    const yawnScaleY = idle.yawn ? 0.94 : 1;

    const sizeStyle: React.CSSProperties =
      typeof size === "number"
        ? { width: size, height: size }
        : { width: "100%", height: "100%" };

    return (
      <motion.button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? `WallE character, mood ${mood}. Click to talk.`}
        data-mood={mood}
        data-speaking={speaking ? "true" : "false"}
        className="walle-bot group relative inline-flex items-center justify-center rounded-2xl bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        style={sizeStyle}
        animate={bodyVariant}
        variants={{
          rest: { y: 0, rotate: 0, scale: 1 },
          speaking: { y: -3, rotate: -1.5, scale: 1.025 },
          alert: { y: 0, rotate: 0, scale: 1.04 },
          cheer: { y: -4, rotate: 0, scale: 1.05 },
          yawn: { y: 1, rotate: 1, scale: 1.005 },
        }}
        transition={{ type: "spring", stiffness: 200, damping: 18, mass: 0.7 }}
        whileHover={{ y: -3, transition: { duration: 0.2 } }}
        whileTap={{ scale: 0.95 }}
      >
        {/* Alert-mood shake wrapper — re-mounts on key change for a clean jolt. */}
        <motion.div
          key={shakeKey}
          className="relative h-full w-full"
          animate={
            mood === "alert"
              ? { x: [0, -2, 2, -1.5, 1.5, 0], rotate: [0, -1, 1, -0.8, 0.8, 0] }
              : undefined
          }
          transition={
            mood === "alert"
              ? { duration: 0.55, repeat: Infinity, repeatDelay: 1.6 }
              : undefined
          }
        >
          {/* Idle parallax + head tilt + yawn squash — the layer that gives the
              vendored Lottie a personality on top of its baseline loop. */}
          <motion.div
            className="relative h-full w-full"
            animate={{
              x: offsetX,
              y: offsetY,
              rotate: headRotate,
              scaleY: yawnScaleY,
            }}
            transition={{ type: "spring", stiffness: 240, damping: 22, mass: 0.6 }}
            style={{ transformOrigin: "50% 65%" }}
          >
            <DotLottieReact
              src="/walle-vendor/robot.json"
              autoplay
              loop
              renderConfig={{ autoResize: true }}
              dotLottieRefCallback={setPlayer}
              style={{ width: "100%", height: "100%" }}
              aria-hidden="true"
            />

            {/* Eyelid shutter — punches a visible blink over the goggle band.
                Positioned by ratio so it scales with the canvas. */}
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute"
              style={{
                left: "12%",
                right: "12%",
                top: "26%",
                height: "22%",
                borderRadius: "999px",
                background:
                  "radial-gradient(ellipse at center, rgba(40,28,14,0.95) 0%, rgba(40,28,14,0.0) 75%)",
                transformOrigin: "50% 50%",
              }}
              animate={{ scaleY: idle.blink ? 1 : 0 }}
              transition={{
                duration: idle.blink ? 0.07 : 0.14,
                ease: "easeOut",
              }}
            />

            {/* Mood tint — soft color wash, multiply-blended on top. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-500"
              style={{
                mixBlendMode: "multiply",
                opacity:
                  mood === "alert"
                    ? 0.35
                    : mood === "celebrating"
                      ? 0.25
                      : mood === "thinking"
                        ? 0.22
                        : 0,
                background:
                  mood === "alert"
                    ? "radial-gradient(circle at 50% 45%, #ff7a7a 0%, transparent 65%)"
                    : mood === "celebrating"
                      ? "radial-gradient(circle at 50% 45%, #7affb0 0%, transparent 65%)"
                      : mood === "thinking"
                        ? "radial-gradient(circle at 50% 45%, #a994ff 0%, transparent 65%)"
                        : "transparent",
              }}
            />

            {/* Speaking pulse halo. */}
            {speaking && (
              <motion.div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{
                  boxShadow: "0 0 0 0 rgba(129,140,248,0.55)",
                }}
                animate={{
                  boxShadow: [
                    "0 0 0 0 rgba(129,140,248,0.55)",
                    "0 0 0 14px rgba(129,140,248,0.0)",
                  ],
                }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
              />
            )}
          </motion.div>
        </motion.div>
      </motion.button>
    );
  },
);

export default WallEBot;
