/**
 * WallEBot — cute animated robot character for the dashboard.
 *
 * Boxy, expressive bot with binocular goggle-eyes, an antenna, treads, and a
 * little chest screen. All animation is pure CSS (see character-vendor/
 * walle-bot.css) — zero JS animation loops, zero runtime dependencies.
 *
 * Idle animations (always on):
 *   - breathing body bob
 *   - blink (eyelids)
 *   - eye glance (pupils drift around)
 *   - antenna sway
 *   - tread hum (subtle scale)
 *
 * Mood-driven overrides:
 *   - listening:    brighter, more attentive eyes
 *   - thinking:     head sway, violet tint
 *   - alert:        anxious shake, red tint, darting eyes
 *   - celebrating:  green tint, right-arm wave + bounce
 *
 * Replaces the old <WallEOrb /> three.js/orb implementation. See
 * character-vendor/README.md for the asset-selection rationale.
 */
"use client";

import { forwardRef } from "react";
import { motion } from "framer-motion";
import type { Mood } from "./walle.types";
import { useWalleIdle } from "./walle.idle";
import "./character-vendor/walle-bot.css";

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

/**
 * The character SVG. Group ids are referenced by walle-bot.css for the per-
 * group animations. All colors pull from CSS custom properties on the root
 * `.walle-bot` element so a single `data-mood` swap restyles every part.
 */
const WallEBot = forwardRef<HTMLButtonElement, WallEBotProps>(
  function WallEBot({ mood, size, onClick, ariaLabel, speaking = false }, ref) {
    const sizeStyle: React.CSSProperties | undefined =
      typeof size === "number" ? { width: size, height: size } : undefined;

    // Idle scheduler — randomized micro-behaviors + cursor tracking.
    const idle = useWalleIdle(mood);

    // Map mood + speaking → body lean variant. Subtle but reads as "alive".
    const bodyVariant = speaking
      ? "speaking"
      : mood === "alert"
        ? "alert"
        : mood === "celebrating"
          ? "cheer"
          : idle.yawn
            ? "yawn"
            : "rest";

    // Pupil offset — combine cursor tracking + idle glance pulses.
    const cursorPx = 2.4; // max travel from cursor follow (svg units ≈ px)
    const glancePx = 4;
    const px =
      idle.glanceLeft
        ? -glancePx
        : idle.glanceRight
          ? glancePx
          : idle.cursorX * cursorPx;
    const py = idle.cursorY * 1.2;

    return (
      <motion.button
        ref={ref}
        type="button"
        className="walle-bot"
        data-mood={mood}
        data-speaking={speaking ? "true" : "false"}
        onClick={onClick}
        style={sizeStyle}
        aria-label={ariaLabel ?? `WallE character, mood ${mood}. Click to talk.`}
        animate={bodyVariant}
        variants={{
          rest:     { y: 0, rotate: 0, scale: 1 },
          speaking: { y: -2, rotate: -1.5, scale: 1.015 },
          alert:    { y: 0, rotate: 0, scale: 1.03 },
          cheer:    { y: -3, rotate: 0, scale: 1.04 },
          yawn:     { y: 1, rotate: 1, scale: 1.005 },
        }}
        transition={{ type: "spring", stiffness: 200, damping: 18, mass: 0.7 }}
        whileHover={{ y: -3, transition: { duration: 0.2 } }}
        whileTap={{ scale: 0.96 }}
      >
        <svg
          viewBox="0 0 200 220"
          role="img"
          aria-hidden="true"
          focusable="false"
        >
          {/* Soft floor shadow */}
          <ellipse
            cx="100"
            cy="208"
            rx="58"
            ry="6"
            fill="rgba(0,0,0,0.35)"
          />

          {/* ── Antenna ─────────────────────────────────────────── */}
          <g
            className="wb-antenna"
            style={
              idle.antennaTwitch
                ? {
                    transform: "rotate(14deg)",
                    transformOrigin: "100px 50px",
                    transition: "transform 220ms cubic-bezier(0.34,1.56,0.64,1)",
                  }
                : undefined
            }
          >
            <line
              x1="100"
              y1="50"
              x2="100"
              y2="22"
              stroke="var(--walle-body-edge)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="100" cy="20" r="4" fill="var(--walle-eye)" />
            <circle
              cx="100"
              cy="20"
              r="6.5"
              fill="var(--walle-eye)"
              opacity="0.35"
            />
          </g>

          {/* ── Body (treads + torso + head all bob together) ──── */}
          <g className="wb-body">
            {/* ── Treads ──────────────────────────────────────── */}
            <g className="wb-treads">
              <rect
                x="22"
                y="160"
                width="156"
                height="38"
                rx="14"
                fill="var(--walle-tread)"
              />
              {/* Wheel hubs */}
              <circle cx="48" cy="179" r="9" fill="var(--walle-body-edge)" />
              <circle cx="48" cy="179" r="3" fill="var(--walle-tread)" />
              <circle cx="100" cy="179" r="9" fill="var(--walle-body-edge)" />
              <circle cx="100" cy="179" r="3" fill="var(--walle-tread)" />
              <circle cx="152" cy="179" r="9" fill="var(--walle-body-edge)" />
              <circle cx="152" cy="179" r="3" fill="var(--walle-tread)" />
              {/* Tread bumps */}
              {[35, 55, 75, 95, 115, 135, 155, 175].map((x) => (
                <rect
                  key={x}
                  x={x}
                  y="195"
                  width="6"
                  height="4"
                  rx="1.5"
                  fill="var(--walle-body-edge)"
                  opacity="0.6"
                />
              ))}
            </g>

            {/* ── Torso ───────────────────────────────────────── */}
            <g>
              <rect
                x="42"
                y="100"
                width="116"
                height="65"
                rx="10"
                fill="var(--walle-body)"
              />
              <rect
                x="42"
                y="100"
                width="116"
                height="10"
                rx="10"
                fill="var(--walle-body-edge)"
                opacity="0.4"
              />
              {/* Chest screen */}
              <rect
                x="68"
                y="118"
                width="64"
                height="32"
                rx="4"
                fill="var(--walle-screen)"
                stroke="var(--walle-body-edge)"
                strokeWidth="1.5"
              />
              {/* Pulse bar inside chest screen */}
              <rect
                x="74"
                y="132"
                width="52"
                height="4"
                rx="2"
                fill="var(--walle-eye)"
                opacity="0.7"
              />
              <rect
                x="74"
                y="140"
                width="32"
                height="3"
                rx="1.5"
                fill="var(--walle-eye)"
                opacity="0.45"
              />

              {/* ── Left arm (static) ─────────────────────────── */}
              <g>
                <rect
                  x="28"
                  y="115"
                  width="14"
                  height="38"
                  rx="6"
                  fill="var(--walle-arm)"
                />
                <circle cx="35" cy="153" r="8" fill="var(--walle-body-edge)" />
              </g>

              {/* ── Right arm (waves in celebrating mood) ─────── */}
              <g className="wb-arm-r">
                <rect
                  x="158"
                  y="115"
                  width="14"
                  height="38"
                  rx="6"
                  fill="var(--walle-arm)"
                />
                <circle cx="165" cy="153" r="8" fill="var(--walle-body-edge)" />
              </g>
            </g>

            {/* ── Head + binocular goggles ───────────────────── */}
            <g
              className="wb-head"
              style={
                idle.headTilt
                  ? {
                      transform: "rotate(3.5deg)",
                      transformOrigin: "100px 100px",
                      transition: "transform 700ms cubic-bezier(0.22,1,0.36,1)",
                    }
                  : undefined
              }
            >
              {/* Neck */}
              <rect
                x="92"
                y="92"
                width="16"
                height="14"
                rx="3"
                fill="var(--walle-body-edge)"
              />
              {/* Head plate (binocular bar) */}
              <rect
                x="38"
                y="50"
                width="124"
                height="48"
                rx="22"
                fill="var(--walle-body)"
              />
              <rect
                x="38"
                y="50"
                width="124"
                height="14"
                rx="22"
                fill="var(--walle-body-edge)"
                opacity="0.35"
              />

              {/* ── Left eye ────────────────────────────────── */}
              <g>
                <circle cx="74" cy="74" r="18" fill="var(--walle-screen)" />
                <circle
                  cx="74"
                  cy="74"
                  r="18"
                  fill="none"
                  stroke="var(--walle-body-edge)"
                  strokeWidth="2"
                />
                {/* Pupil */}
                <g
                  className="wb-eye-pupil"
                  style={{
                    transform: `translate(${px}px, ${py}px)`,
                    transition: "transform 320ms cubic-bezier(0.22,1,0.36,1)",
                  }}
                >
                  <circle cx="74" cy="74" r="8" fill="var(--walle-eye)" />
                  <circle cx="77" cy="71" r="3" fill="#ffffff" opacity="0.8" />
                </g>
                {/* Eyelid (blink). Translucent shutter that closes over eye. */}
                <rect
                  className="wb-eye-lid"
                  x="56"
                  y="56"
                  width="36"
                  height="36"
                  rx="18"
                  fill="var(--walle-body)"
                  style={
                    idle.blink
                      ? { transform: "scaleY(0.05)", transformOrigin: "50% 50%" }
                      : undefined
                  }
                />
              </g>

              {/* ── Right eye ───────────────────────────────── */}
              <g>
                <circle cx="126" cy="74" r="18" fill="var(--walle-screen)" />
                <circle
                  cx="126"
                  cy="74"
                  r="18"
                  fill="none"
                  stroke="var(--walle-body-edge)"
                  strokeWidth="2"
                />
                <g
                  className="wb-eye-pupil"
                  style={{
                    transform: `translate(${px}px, ${py}px)`,
                    transition: "transform 320ms cubic-bezier(0.22,1,0.36,1)",
                  }}
                >
                  <circle cx="126" cy="74" r="8" fill="var(--walle-eye)" />
                  <circle cx="129" cy="71" r="3" fill="#ffffff" opacity="0.8" />
                </g>
                <rect
                  className="wb-eye-lid wb-eye-lid-r"
                  x="108"
                  y="56"
                  width="36"
                  height="36"
                  rx="18"
                  fill="var(--walle-body)"
                  style={
                    idle.blink
                      ? { transform: "scaleY(0.05)", transformOrigin: "50% 50%" }
                      : undefined
                  }
                />
              </g>
            </g>
          </g>
        </svg>
      </motion.button>
    );
  },
);

export default WallEBot;
