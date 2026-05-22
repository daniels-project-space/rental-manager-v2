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
  const [chatOpen, setChatOpen] = useState(false);

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
      className="relative h-full w-full rounded-[1rem] bg-card/85 border border-white/5 p-3 overflow-hidden"
      data-walle-mood={mood}
    >
      {/* Character — fills the tile, click triggers narration */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div style={{ width: '78%', height: '88%' }}>
          <WallEBotLazy mood={mood} onClick={handleCharacterClick} />
        </div>
      </div>

      {/* Speech bubble overlay — positioned next to character's head */}
      {bubble ? (
        <div
          className="absolute pointer-events-none"
          style={{ top: '8%', right: '6%', maxWidth: '60%' }}
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

      {/* Identity tag — top-left */}
      <div className="absolute top-3 left-3 leading-tight pointer-events-none">
        <div className="text-xs font-semibold text-white/90">WallE</div>
        <div className="text-[9px] uppercase tracking-wider text-slate-400">
          {mood}
        </div>
      </div>

      {/* Talk-to-WallE button — bottom-right */}
      <button
        type="button"
        onClick={() => setChatOpen(true)}
        className="absolute bottom-3 right-3 rounded-full bg-indigo-500/85 hover:bg-indigo-500 transition px-3 py-1.5 text-[11px] font-medium text-white shadow-lg shadow-indigo-500/30"
        aria-label="Open WallE chat"
      >
        Talk to WallE →
      </button>

      {/* Chat drawer overlay */}
      {chatOpen ? (
        <WallEChatDrawer onClose={() => setChatOpen(false)}>
          <WallEChat
            onChatStateChange={setChatState}
            lastSignalChangeAt={lastChangeAt}
          />
        </WallEChatDrawer>
      ) : null}
    </div>
  );
}

/**
 * Lightweight overlay drawer for the chat. Fixed-position, click-outside-
 * to-close, ESC-to-close. No new library — keeps bundle flat.
 */
function WallEChatDrawer({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="WallE chat"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:w-[420px] h-[80vh] sm:h-[600px] max-h-[90vh] rounded-2xl border border-white/10 bg-zinc-950/95 shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-zinc-200">
          <div className="text-sm font-semibold">WallE</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="Close WallE chat"
          >
            Close
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </div>
    </div>
  );
}
