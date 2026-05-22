/**
 * WallEOrb — mood-reactive watercolor orb for the dashboard assistant.
 *
 * Wraps the vendored ElevenLabs UI Orb (MIT, ./orb-vendor/orb.tsx). Maps our
 * Mood enum to the orb's `colors` + `agentState` props via MOOD_VISUALS.
 *
 * Includes a runtime WebGL capability check. If unavailable (server-side
 * render, headless browser without WebGL, very old device, or the user has
 * disabled hardware accel) we fall back to a pure-CSS radial-gradient pulse
 * that uses the existing `animate-pulse-glow` keyframe from globals.css.
 *
 * Default export so dynamic() with `ssr:false` produces a clean code-split
 * chunk and three.js never ships in the initial dashboard bundle.
 */
"use client";

import { useEffect, useState } from 'react';
import { Orb } from './orb-vendor/orb';
import { MOOD_VISUALS, moodToAgentState } from './walle.mood';
import type { Mood } from './walle.types';

export interface WallEOrbProps {
  mood: Mood;
  /** Outer square edge length in px. Default 240 (fits 2x2 hero card). */
  size?: number;
}

/** Probe for usable WebGL. Returns null on the server. */
function detectWebGL(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    return !!gl;
  } catch {
    return false;
  }
}

function WallEOrb({ mood, size = 240 }: WallEOrbProps) {
  const visual = MOOD_VISUALS[mood];
  const [webgl, setWebgl] = useState<boolean | null>(null);

  useEffect(() => {
    setWebgl(detectWebGL());
  }, []);

  // Server / pre-detection: render the CSS fallback so first paint is non-blank.
  if (webgl === null || webgl === false) {
    return (
      <div
        className="relative flex items-center justify-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`WallE orb, mood: ${mood}`}
      >
        <div
          className="rounded-full animate-pulse-glow"
          style={{
            width: size * 0.85,
            height: size * 0.85,
            background: `radial-gradient(circle at 35% 35%, ${visual.secondary} 0%, ${visual.primary} 45%, transparent 75%)`,
            opacity: 0.85,
            filter: `blur(${Math.round(size * 0.02)}px)`,
            animationDuration: `${(2 / visual.speed).toFixed(2)}s`,
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`WallE orb, mood: ${mood}`}
    >
      <Orb
        colors={[visual.primary, visual.secondary]}
        agentState={moodToAgentState(mood)}
        volumeMode="manual"
        manualInput={visual.intensity}
        manualOutput={visual.intensity * 0.85}
      />
    </div>
  );
}

export default WallEOrb;
