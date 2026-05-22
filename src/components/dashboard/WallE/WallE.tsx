/**
 * WallE — parent shell for the dashboard assistant widget.
 *
 * REDESIGN (2026-05-22): the orb + chip-strip + prominent chat panel is
 * replaced by a cute animated robot character that LIVES in the 2x2 tile
 * with an overlay speech bubble. The full chat is tucked behind a small
 * "Talk to WallE" button that opens a drawer / modal.
 *
 * Composition:
 *   - WallEBotLazy        — character renderer (idle anims + mood states).
 *   - WallESpeechBubble   — short narration line w/ tail + autodismiss.
 *   - WallEChat (drawer)  — full chat behind a controlled overlay.
 *   - useWallESignals     — used internally to drive narration triggers; no
 *                           chips rendered.
 *   - deriveMood          — pure reducer: signals + chatState + idleSinceMs.
 *
 * Narration triggers:
 *   1. On mount → narrate(mode='greeting').
 *   2. On lastChangeAt increasing AND new top signal severity === 'alert'
 *      → narrate(mode='alert') (cooldown 30s).
 *   3. On character click → narrate(mode='click') (no cooldown).
 *   4. Phase-7 idle loop now drives a bubble narrate(mode='idle') instead of
 *      injecting a fake chat message. Idle threshold stays 2 minutes.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WallEBotLazy from './WallEBotLazy';
import { useWallESignals } from './WallESignals';
import WallEChat from './WallEChat';
import WallESpeechBubble from './WallESpeechBubble';
import { deriveMood } from './walle.mood';
import { JOKE_IDLE_AFTER_MS } from './walle.jokes';
import type { Signal, WallEChatState } from './walle.types';

export interface WallEProps {
  accountSlug?: string | null;
}

/** Stable client-side identifier matching WallEChat's. */
function getOrCreateWalleUserId(): string {
  if (typeof window === 'undefined') return 'ssr';
  try {
    const existing = window.localStorage.getItem('walle_user');
    if (existing) return existing;
    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `walle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem('walle_user', fresh);
    return fresh;
  } catch {
    return `walle-anon-${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface Bubble {
  id: string;
  text: string;
  tone: 'neutral' | 'alert' | 'celebrating';
}

const AUTO_POP_COOLDOWN_MS = 30_000;

export default function WallE({ accountSlug = null }: WallEProps) {
  // ── Chat-derived activity state. WallEChat reports via callback. ──
  const [chatState, setChatState] = useState<WallEChatState>('idle');

  // Mount timestamp for idle proxy.
  const mountedAt = useRef<number>(Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // Live signals — single subscription used for mood + narration triggers.
  const { signals, lastChangeAt } = useWallESignals(accountSlug);

  const idleSinceMs = chatState === 'idle' ? now - mountedAt.current : 0;
  const mood = useMemo(
    () => deriveMood(signals, { idleSinceMs, chatState }),
    [signals, idleSinceMs, chatState],
  );

  // ── Speech bubble state ──────────────────────────────────────────
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const lastAutoPopAtRef = useRef<number>(0);
  const userIdRef = useRef<string>('');
  if (!userIdRef.current) userIdRef.current = getOrCreateWalleUserId();

  const dismissBubble = useCallback(() => setBubble(null), []);

  const requestNarration = useCallback(
    async (
      mode: 'greeting' | 'alert' | 'click' | 'idle',
      context?: string,
      tone: Bubble['tone'] = 'neutral',
    ) => {
      try {
        const res = await fetch('/api/walle/narrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: userIdRef.current, mode, context }),
        });
        if (!res.ok) return;
        const data: { line?: string | null } = await res.json();
        const line = data?.line?.trim();
        if (!line) return;
        setBubble({
          id: `walle-bubble-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text: line,
          tone,
        });
      } catch {
        // silent — bubble UX is best-effort
      }
    },
    [],
  );

  // ── Trigger 1: greeting on mount ─────────────────────────────────
  const greetedRef = useRef(false);
  useEffect(() => {
    if (greetedRef.current) return;
    greetedRef.current = true;
    void requestNarration('greeting');
  }, [requestNarration]);

  // ── Trigger 2: auto-pop on alert (top signal severity flipped to alert) ──
  const prevLastChangeAtRef = useRef<number>(0);
  const prevTopSignalIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastChangeAt === prevLastChangeAtRef.current) return;
    prevLastChangeAtRef.current = lastChangeAt;

    const top: Signal | undefined = signals[0];
    const prevId = prevTopSignalIdRef.current;
    prevTopSignalIdRef.current = top?.id ?? null;
    if (!top) return;
    if (top.severity !== 'alert') return;
    if (top.id === prevId) return; // same alert as before, no re-pop

    const sinceLast = Date.now() - lastAutoPopAtRef.current;
    if (sinceLast < AUTO_POP_COOLDOWN_MS) return;
    lastAutoPopAtRef.current = Date.now();
    void requestNarration('alert', top.label, 'alert');
  }, [signals, lastChangeAt, requestNarration]);

  // ── Trigger 3: click handler ─────────────────────────────────────
  const handleCharacterClick = useCallback(() => {
    void requestNarration('click');
  }, [requestNarration]);

  // ── Trigger 4: idle joke loop — bubble instead of chat ───────────
  const lastIdleActivityRef = useRef<number>(Date.now());
  const idleFiredInWindowRef = useRef<boolean>(false);
  // Bump on signal change, on chat-state non-idle, on bubble appearance.
  useEffect(() => {
    lastIdleActivityRef.current = Date.now();
    idleFiredInWindowRef.current = false;
  }, [lastChangeAt, chatState, bubble?.id]);

  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      if (chatState !== 'idle') return;
      if (bubble) return;
      if (idleFiredInWindowRef.current) return;
      if (Date.now() - lastIdleActivityRef.current < JOKE_IDLE_AFTER_MS) return;
      idleFiredInWindowRef.current = true;
      void requestNarration('idle');
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chatState, bubble, requestNarration]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div
      className="relative h-full w-full rounded-[1rem] bg-card/85 border border-white/5 p-2 overflow-hidden flex flex-col md:flex-row gap-2"
      data-walle-mood={mood}
    >
      {/* LEFT PANEL — character + name + mood chip */}
      <div className="relative flex md:w-[140px] w-full md:flex-col flex-row md:h-full h-[110px] items-center md:justify-start justify-center md:py-2 shrink-0 rounded-lg bg-white/[0.02]">
        {/* Character */}
        <div className="relative flex items-center justify-center md:w-[110px] md:h-[110px] w-[80px] h-[80px] shrink-0">
          <WallEBotLazy mood={mood} onClick={handleCharacterClick} />

          {/* Speech bubble — anchored to character, overlays bot area */}
          {bubble ? (
            <div
              className="absolute pointer-events-none z-10"
              style={{
                top: '-4px',
                left: '50%',
                transform: 'translateX(-30%)',
                maxWidth: '180px',
              }}
            >
              <WallESpeechBubble
                key={bubble.id}
                id={bubble.id}
                text={bubble.text}
                tone={bubble.tone}
                onDismiss={dismissBubble}
              />
            </div>
          ) : null}
        </div>

        {/* Identity tag */}
        <div className="md:mt-2 md:ml-0 ml-3 leading-tight pointer-events-none text-center md:text-center text-left">
          <div className="text-xs font-semibold text-white/90">WallE</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-400">
            {mood}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL — inline chat */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col">
        <WallEChat
          onChatStateChange={setChatState}
          lastSignalChangeAt={lastChangeAt}
          className="h-full"
          emptyHint="Talk to WallE — ask about conflicts, revenue, anything…"
          compact
        />
      </div>
    </div>
  );
}
