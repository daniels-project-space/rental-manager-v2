/**
 * WallE — parent shell for the dashboard assistant widget.
 *
 * REDESIGN (2026-05-22, dock animation):
 *   - Speech bubble REMOVED. Character flows through mood/animation only.
 *   - Two layout states driven by chat engagement:
 *       RESTING — big character in left rail, idle anims at normal cadence.
 *       ENGAGED — character smoothly shrinks (~0.32x) and docks at the
 *                 top-left of the chat panel; chat takes over the cell.
 *   - One shared bot DOM node, animated via CSS custom properties (--bot-x,
 *     --bot-y, --bot-s) on `.walle-cell[data-engaged]`. Transition is
 *     620ms cubic-bezier(0.22, 1, 0.36, 1).
 *   - Click on the big character triggers a short wave (data-wave="true"
 *     for 720ms). The /api/walle/narrate endpoint is no longer called.
 *
 * Engagement signals (any one → engaged):
 *   - WallEChat reports chatState !== 'idle'  (typing or thinking)
 *   - A message exchange happened in the last 8s (lastChatActivityRef)
 *
 * After engagement ends, we wait 4s before animating back to RESTING.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WallEBotLazy from './WallEBotLazy';
import { useWallESignals } from './WallESignals';
import WallEChat from './WallEChat';
import { deriveMood } from './walle.mood';
import type { WallEChatState } from './walle.types';
import './walle-cell.css';

export interface WallEProps {
  accountSlug?: string | null;
}

const IDLE_RETURN_DELAY_MS = 4_000;
const RECENT_ACTIVITY_WINDOW_MS = 8_000;

export default function WallE({ accountSlug = null }: WallEProps) {
  // ── Chat-derived activity state ──────────────────────────────────
  const [chatState, setChatState] = useState<WallEChatState>('idle');

  // Mount timestamp for idle proxy.
  const mountedAt = useRef<number>(Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // Live signals — single subscription used for mood derivation.
  const { signals, lastChangeAt } = useWallESignals(accountSlug);

  const idleSinceMs = chatState === 'idle' ? now - mountedAt.current : 0;
  const mood = useMemo(
    () => deriveMood(signals, { idleSinceMs, chatState }),
    [signals, idleSinceMs, chatState],
  );

  // ── Engagement state machine ─────────────────────────────────────
  const [chatEngaged, setChatEngaged] = useState(false);
  const lastChatActivityRef = useRef<number>(0);
  // Bump on every chatState transition (proxy for user activity).
  useEffect(() => {
    if (chatState !== 'idle') {
      lastChatActivityRef.current = Date.now();
    }
  }, [chatState]);

  // Compute desired engaged value; debounce un-engagement by 4s.
  useEffect(() => {
    const recentlyActive =
      Date.now() - lastChatActivityRef.current < RECENT_ACTIVITY_WINDOW_MS;
    const wantEngaged = chatState !== 'idle' || recentlyActive;
    if (wantEngaged) {
      if (!chatEngaged) setChatEngaged(true);
      return;
    }
    // chatState idle AND no recent activity → schedule return after delay.
    const t = setTimeout(() => {
      const stillIdle =
        chatState === 'idle' &&
        Date.now() - lastChatActivityRef.current >= RECENT_ACTIVITY_WINDOW_MS;
      if (stillIdle) setChatEngaged(false);
    }, IDLE_RETURN_DELAY_MS);
    return () => clearTimeout(t);
  }, [chatState, chatEngaged, now]);

  // ── Click wave cue ───────────────────────────────────────────────
  const [waving, setWaving] = useState(false);
  const handleCharacterClick = useCallback(() => {
    setWaving(true);
    setTimeout(() => setWaving(false), 720);
  }, []);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div
      className="walle-cell relative h-full w-full rounded-[1rem] bg-card/85 border border-white/5 p-2 overflow-hidden flex flex-col md:flex-row gap-2"
      data-walle-mood={mood}
      data-engaged={chatEngaged ? 'true' : 'false'}
      data-wave={waving ? 'true' : 'false'}
    >
      {/* SHARED BOT STAGE — one DOM node, transformed between two positions.
          When NOT engaged it visually occupies the left rail. When engaged
          it shrinks + translates to overlap the dock slot in the chat. */}
      <div className="walle-stage" aria-hidden={false}>
        <div className="md:w-[110px] md:h-[110px] w-[80px] h-[80px] shrink-0">
          <WallEBotLazy mood={mood} onClick={handleCharacterClick} />
        </div>
      </div>

      {/* LEFT RAIL — fades out when engaged. Provides the rest-state
          background card + identity tag; bot itself lives in .walle-stage. */}
      <div className="walle-left-rail relative flex md:w-[140px] w-full md:flex-col flex-row md:h-full h-[110px] items-center md:justify-end justify-center md:py-2 shrink-0 rounded-lg bg-white/[0.02]">
        {/* Spacer to mirror the bot footprint so layout stays stable. */}
        <div className="md:w-[110px] md:h-[110px] w-[80px] h-[80px] shrink-0" />
        <div className="md:mt-2 md:ml-0 ml-3 leading-tight pointer-events-none text-center md:text-center text-left">
          <div className="text-xs font-semibold text-white/90">WallE</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-400">
            {mood}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL — inline chat. The dock slot sits inside the chat
          header area; the bot stage transforms to overlap it. */}
      <div className="walle-chat-pane flex-1 min-h-0 min-w-0 flex flex-col">
        <WallEChat
          onChatStateChange={setChatState}
          lastSignalChangeAt={lastChangeAt}
          className="h-full"
          emptyHint="Talk to WallE — ask about conflicts, revenue, anything…"
          compact
          showDockSlot={chatEngaged}
        />
      </div>
    </div>
  );
}
