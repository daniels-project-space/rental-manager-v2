/**
 * walle.idle.ts — independent randomized idle-behavior scheduler.
 *
 * Each behavior has its own setTimeout that re-schedules itself with a fresh
 * random interval, so behaviors never phase-lock and the character feels alive
 * (not metronomic). All flags are short-lived booleans the consumer renders
 * through framer-motion `animate` props on `WallEBot`.
 *
 * Behaviors:
 *   - blink          (3-7s)    eyelids close briefly
 *   - glanceLeft     (8-15s)   pupils slide left
 *   - glanceRight    (8-15s)   pupils slide right
 *   - yawn           (40-90s)  chest screen briefly stretches
 *   - headTilt       (12-25s)  head rotates ±3deg
 *   - antennaTwitch  (6-14s)   antenna jolts
 *
 * Plus passive: `cursorX`, `cursorY` — viewport-relative pointer position
 * (clamped to ±1) so the consumer can offset the pupils toward the cursor.
 *
 * Mood overrides:
 *   - alert/thinking/listening freeze randomized loops (mood drives them).
 *   - idle/celebrating run the full loop.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { Mood } from "./walle.types";

export interface IdleState {
  blink: boolean;
  glanceLeft: boolean;
  glanceRight: boolean;
  yawn: boolean;
  headTilt: boolean;
  antennaTwitch: boolean;
  /** -1..1 — viewport-normalized pointer X offset from screen center. */
  cursorX: number;
  /** -1..1 — viewport-normalized pointer Y offset from screen center. */
  cursorY: number;
}

const IDLE_DEFAULT: IdleState = {
  blink: false,
  glanceLeft: false,
  glanceRight: false,
  yawn: false,
  headTilt: false,
  antennaTwitch: false,
  cursorX: 0,
  cursorY: 0,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * useWalleIdle — drive 6 independent idle micro-behaviors + cursor tracking.
 *
 * Pass current mood so the scheduler can pause behaviors when mood-specific
 * anims should take over (e.g. alert shake, thinking head sway).
 */
export function useWalleIdle(mood: Mood = "idle"): IdleState {
  const [state, setState] = useState<IdleState>(IDLE_DEFAULT);
  const cursorRef = useRef({ x: 0, y: 0 });
  // Coalesce cursor updates onto rAF so we never thrash setState.
  const cursorRafRef = useRef<number | null>(null);

  // Mood gate — when non-idle moods drive the visuals, we still run blinks
  // (they look natural always) but skip the heavier behaviors.
  const heavyEnabled = mood === "idle" || mood === "celebrating";

  useEffect(() => {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    function schedule(
      run: () => void,
      minMs: number,
      maxMs: number,
    ): void {
      const t = setTimeout(() => {
        timers.delete(t);
        if (cancelled) return;
        run();
        schedule(run, minMs, maxMs);
      }, rand(minMs, maxMs));
      timers.add(t);
    }

    function pulse(key: keyof IdleState, durationMs: number): void {
      setState((s) => ({ ...s, [key]: true }));
      const t = setTimeout(() => {
        timers.delete(t);
        if (cancelled) return;
        setState((s) => ({ ...s, [key]: false }));
      }, durationMs);
      timers.add(t);
    }

    // Blinks always run — most natural baseline.
    schedule(() => pulse("blink", 140), 3000, 7000);
    if (heavyEnabled) {
      schedule(() => pulse("glanceLeft", 700), 8000, 15000);
      schedule(() => pulse("glanceRight", 700), 9000, 16000);
      schedule(() => pulse("yawn", 1200), 40_000, 90_000);
      schedule(() => pulse("headTilt", 1400), 12_000, 25_000);
      schedule(() => pulse("antennaTwitch", 600), 6000, 14_000);
    }

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [heavyEnabled]);

  // Passive cursor tracking — pupils gently follow the pointer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onMove(e: PointerEvent): void {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      // Normalize to -1..1 around viewport center.
      const nx = Math.max(-1, Math.min(1, (e.clientX - w / 2) / (w / 2)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - h / 2) / (h / 2)));
      cursorRef.current = { x: nx, y: ny };
      if (cursorRafRef.current != null) return;
      cursorRafRef.current = requestAnimationFrame(() => {
        cursorRafRef.current = null;
        setState((s) =>
          s.cursorX === cursorRef.current.x && s.cursorY === cursorRef.current.y
            ? s
            : { ...s, cursorX: cursorRef.current.x, cursorY: cursorRef.current.y },
        );
      });
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (cursorRafRef.current != null) {
        cancelAnimationFrame(cursorRafRef.current);
        cursorRafRef.current = null;
      }
    };
  }, []);

  return state;
}
