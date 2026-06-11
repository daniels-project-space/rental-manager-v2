/**
 * WallE — parent shell for the dashboard assistant widget (Option C layout).
 *
 * REDESIGN (2026-05-22, polish pass):
 *   - Character is INSIDE the chat (top-left), not in a separate rail.
 *   - Latest assistant message renders as a head-tethered speech bubble next
 *     to him (WallEChat owns the bubble; see WallESpeechBubble + tail).
 *   - Older messages flow below as smaller styled bubbles with a tiny WallE
 *     face avatar.
 *   - Mood (alert/celebrating/thinking/listening) → bubbleTone + character
 *     mood pose. `speaking` (fresh assistant turn arrived) → lean-forward.
 *   - Idle behaviors handled by useWalleIdle inside WallEBot (no dock anim).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import WallEBotLazy from './WallEBotLazy';
import { useWallESignals } from './WallESignals';
import WallEChat from './WallEChat';
import { deriveMood } from './walle.mood';
import type { WallEChatState, Mood } from './walle.types';
import type { BubbleTone } from './WallESpeechBubble';
import './walle-cell.css';

export interface WallEProps {
  accountSlug?: string | null;
}

function moodToTone(mood: Mood): BubbleTone {
  switch (mood) {
    case 'alert':
      return 'alert';
    case 'celebrating':
      return 'celebrating';
    case 'thinking':
      return 'thinking';
    default:
      return 'neutral';
  }
}

export default function WallE({ accountSlug = null }: WallEProps) {
  // Chat-derived activity state
  const [chatState, setChatState] = useState<WallEChatState>('idle');
  const [speaking, setSpeaking] = useState(false);

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

  // Click wave cue
  const [waving, setWaving] = useState(false);
  const handleCharacterClick = useCallback(() => {
    setWaving(true);
    setTimeout(() => setWaving(false), 720);
  }, []);

  // Collapsed: just the robot + an expand button. Expanded: a larger panel
  // centered on the SCREEN. It is portalled to document.body because the
  // dashboard grid item carries a CSS transform (dnd-kit), which would
  // otherwise make a position:fixed child anchor to the small cell — pushing
  // the panel off-centre and out of bounds.
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const orb = (
    <div className="walle-stage">
      <div className="walle-stage-inner">
        <WallEBotLazy mood={mood} onClick={handleCharacterClick} speaking={speaking} />
      </div>
    </div>
  );

  return (
    <>
      <div
        className="walle-cell relative flex h-[120px] w-full items-center justify-center rounded-[1rem] bg-card/85 border border-white/5 overflow-hidden"
        data-walle-mood={mood}
        data-wave={waving ? 'true' : 'false'}
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Expand WallE to chat"
          aria-label="Expand WallE"
          className="absolute top-1.5 right-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/10 text-[13px] leading-none text-zinc-200 transition-colors hover:bg-white/20 hover:text-white"
        >
          {'\u2922'}
        </button>
        {orb}
      </div>

      {expanded &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            onClick={() => setExpanded(false)}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="walle-cell relative z-10 flex h-[min(620px,86vh)] w-[min(460px,94vw)] flex-col overflow-hidden rounded-[1rem] border border-white/10 bg-card/95 p-2 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-walle-mood={mood}
              data-wave={waving ? 'true' : 'false'}
            >
              <button
                type="button"
                onClick={() => setExpanded(false)}
                title="Collapse WallE"
                aria-label="Collapse WallE"
                className="absolute top-1.5 right-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/10 text-[13px] leading-none text-zinc-200 transition-colors hover:bg-white/20 hover:text-white"
              >
                {'\u2715'}
              </button>
              <WallEChat
                onChatStateChange={setChatState}
                onSpeakingChange={setSpeaking}
                lastSignalChangeAt={lastChangeAt}
                emptyHint="Hi! I'm WallE — ask me anything about your rentals."
                compact={false}
                bubbleTone={moodToTone(mood)}
                className="h-full"
                characterSlot={
                  <div className="walle-stage">
                    <div className="walle-stage-inner">
                      <WallEBotLazy mood={mood} onClick={handleCharacterClick} speaking={speaking} />
                    </div>
                  </div>
                }
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
