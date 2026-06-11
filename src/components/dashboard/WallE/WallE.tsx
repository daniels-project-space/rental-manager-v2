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

  // Small by default; click the arrow to pop WallE into a large floating panel
  // so the chat box is comfortable to type in.
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-[55] bg-black/55 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        />
      )}
      <div
        className={
          expanded
            ? "walle-cell fixed z-[60] bottom-4 right-4 flex h-[560px] max-h-[85vh] w-[400px] max-w-[92vw] flex-col rounded-[1rem] bg-card/95 border border-white/10 p-2 shadow-2xl overflow-hidden"
            : "walle-cell relative h-[160px] w-full rounded-[1rem] bg-card/85 border border-white/5 p-2 overflow-hidden"
        }
        data-walle-mood={mood}
        data-wave={waving ? 'true' : 'false'}
      >
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          title={expanded ? 'Collapse WallE' : 'Expand WallE to chat'}
          aria-label={expanded ? 'Collapse WallE' : 'Expand WallE'}
          className="absolute top-1.5 right-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/10 text-[13px] leading-none text-zinc-200 transition-colors hover:bg-white/20 hover:text-white"
        >
          {expanded ? '✕' : '⤢'}
        </button>
        <WallEChat
          onChatStateChange={setChatState}
          onSpeakingChange={setSpeaking}
          lastSignalChangeAt={lastChangeAt}
          emptyHint="Hi! I'm WallE — ask me anything about your rentals."
          compact={!expanded}
          bubbleTone={moodToTone(mood)}
          className="h-full"
          characterSlot={
            <div className="walle-stage">
              <div className="walle-stage-inner">
                <WallEBotLazy
                  mood={mood}
                  onClick={handleCharacterClick}
                  speaking={speaking}
                />
              </div>
            </div>
          }
        />
      </div>
    </>
  );
}
