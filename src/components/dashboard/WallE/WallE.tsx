/**
 * WallE — parent shell for the dashboard assistant widget (Phase 8).
 *
 * Owns the mood reducer state and stitches together the four building
 * blocks built in earlier phases:
 *   - WallEOrbLazy   (Phase 2) — three.js orb, code-split so initial
 *     dashboard paint ships zero three.js bytes.
 *   - WallESignals   (Phase 4) — live chip strip + useWallESignals hook
 *     that subscribes to the 5 dashboard Convex streams.
 *   - WallEChat      (Phase 5/6/7) — AI SDK v6 chat panel with joke loop.
 *   - deriveMood     (Phase 4) — pure reducer: signals + chatState +
 *     idleSinceMs → Mood.
 *
 * Lives as a single 2x2 cell on the StatsGrid (HERO_SPANS.walle = 2x2).
 * Renders its own rounded card surface so it visually reads as one tile,
 * not a generic stat card.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import WallEOrbLazy from './WallEOrbLazy';
import { WallESignals, useWallESignals } from './WallESignals';
import WallEChat from './WallEChat';
import { MOOD_VISUALS, deriveMood } from './walle.mood';
import type { WallEChatState } from './walle.types';

export interface WallEProps {
  accountSlug?: string | null;
}

export default function WallE({ accountSlug = null }: WallEProps) {
  // Chat-derived activity state. Phase 5/6/7 WallEChat reports this up.
  const [chatState, setChatState] = useState<WallEChatState>('idle');

  // Mount timestamp for a simple idleSinceMs proxy. deriveMood currently
  // only uses idleSinceMs as a void-suppressor (Phase 7 handles the joke
  // loop separately inside WallEChat), so a coarse mount-relative value
  // is enough — no need to react to every keystroke.
  const mountedAt = useRef<number>(Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Live signals — single subscription shared across the orb (mood) and
  // chip strip. Phase 4's hook already memoizes the array reference and
  // bumps lastChangeAt only when the signal set actually changes, so we
  // can hand lastChangeAt straight to WallEChat to reset the joke timer.
  const { signals, lastChangeAt } = useWallESignals(accountSlug);

  const idleSinceMs = chatState === 'idle' ? now - mountedAt.current : 0;

  const mood = useMemo(
    () => deriveMood(signals, { idleSinceMs, chatState }),
    [signals, idleSinceMs, chatState],
  );

  const moodVisual = useMemo(() => MOOD_VISUALS[mood], [mood]);
  void moodVisual; // visual is consumed by WallEOrb internally via `mood` prop.

  return (
    <div
      className="h-full w-full flex flex-col gap-3 rounded-[1rem] bg-card/85 border border-white/5 p-4 overflow-hidden"
      data-walle-mood={mood}
    >
      {/* Top row: orb + identity */}
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0">
          <WallEOrbLazy mood={mood} size={80} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white leading-tight">
            WallE
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400 leading-tight mt-0.5">
            {mood}
          </div>
        </div>
      </div>

      {/* Live signals strip */}
      <div className="overflow-x-auto -mx-1 px-1">
        <WallESignals accountSlug={accountSlug} />
      </div>

      {/* Chat fills remaining height */}
      <div className="flex-1 min-h-0 flex flex-col">
        <WallEChat
          onChatStateChange={setChatState}
          lastSignalChangeAt={lastChangeAt}
        />
      </div>
    </div>
  );
}
