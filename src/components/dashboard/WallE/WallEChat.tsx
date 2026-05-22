/**
 * Phase 5 — WallE chat panel.
 *
 * - Uses `useChat` from `@ai-sdk/react` (AI SDK v6 companion) pointing at
 *   `/api/walle/chat`.
 * - Generates a per-mount `sessionId` (UUID) sent with every request so
 *   the Convex `appendTurn` mutation can group rows. The same id is used
 *   on unmount for a stub `compactSession` summary write — Phase 6 will
 *   replace the naive count summary with an LLM-generated digest.
 * - Surfaces a derived `chatState: 'idle' | 'listening' | 'thinking'` via
 *   the optional `onChatStateChange` prop so the parent shell can map it
 *   to an orb mood (Phase 8 will wire this).
 *
 * No tools, no persona, no rate limit, no joke loop — those land later.
 */
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import type { WallEChatState } from './walle.types';
import { JOKE_IDLE_AFTER_MS } from './walle.jokes';

export interface WallEChatProps {
  /**
   * Called whenever the derived chat state changes. The parent shell
   * (Phase 8) feeds this into the orb mood reducer.
   */
  onChatStateChange?: (state: WallEChatState) => void;
  /**
   * Phase 7 — when provided, dashboard-signal updates reset the idle
   * timer so jokes don't fire on top of fresh alerts. Phase 8 will wire
   * this from the parent shell (single subscription).
   */
  lastSignalChangeAt?: number;
}

/** Phase 7 — stable client-side identifier for the joke-quota endpoint. */
// TODO(phase-9): swap for real auth user id once login lands.
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

// ── Tiny UI helper: extract a flat string from an AI SDK v6 UIMessage ──
function messageText(parts: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

export default function WallEChat({ onChatStateChange, lastSignalChangeAt }: WallEChatProps) {
  // ── Stable per-mount session id ──
  const sessionIdRef = useRef<string>('');
  if (!sessionIdRef.current) {
    sessionIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `walle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const sessionId = sessionIdRef.current;

  // ── Local input state (v6 `useChat` no longer owns the textarea value) ──
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  // ── Chat transport: pipe sessionId in the body of every POST ──
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/walle/chat',
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages, sessionId },
        }),
      }),
    [sessionId]
  );

  const { messages, sendMessage, status } = useChat({ transport });

  const isThinking = status === 'submitted' || status === 'streaming';

  // ── Phase 7: idle-joke trigger ─────────────────────────────────────
  const userIdRef = useRef<string>('');
  if (!userIdRef.current) userIdRef.current = getOrCreateWalleUserId();

  // Tracks the timestamp of the last "user activity" or "system event".
  // Updated on: keypress, message change, parent-supplied signal change.
  const lastActivityRef = useRef<number>(Date.now());
  // One-shot guard so we don't spam the endpoint within the same idle
  // window. Resets when fresh activity bumps the clock.
  const jokeFiredInWindowRef = useRef<boolean>(false);
  // Locally-injected joke messages (kept separate from the AI-SDK list
  // and merged at render time so streaming chunks don't clobber them).
  const [jokeMessages, setJokeMessages] = useState<
    Array<{ id: string; role: 'assistant'; text: string; createdAt: number; isJoke: true }>
  >([]);

  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    jokeFiredInWindowRef.current = false;
  }, []);

  // Any new chat message counts as activity (user sent or assistant replied).
  useEffect(() => {
    bumpActivity();
  }, [messages, bumpActivity]);

  // Parent-supplied signal change resets idle window (optional prop).
  useEffect(() => {
    if (typeof lastSignalChangeAt === 'number') bumpActivity();
  }, [lastSignalChangeAt, bumpActivity]);

  // Idle joke loop intentionally removed (2026-05-22 redesign).
  // The parent shell <WallE /> now owns the idle-narration loop and pipes
  // results through the speech bubble instead of injecting fake chat
  // messages. The pre-existing `/api/walle/joke` route stays available for
  // future callers; we just don't trigger it from here anymore.
  void JOKE_IDLE_AFTER_MS;
  void userIdRef;
  void jokeFiredInWindowRef;
  void setJokeMessages;

  // ── Derived chat-state → parent mood mapping ──
  useEffect(() => {
    if (!onChatStateChange) return;
    let next: WallEChatState = 'idle';
    if (isThinking) next = 'thinking';
    else if (focused && input.trim().length > 0) next = 'listening';
    onChatStateChange(next);
  }, [isThinking, focused, input, onChatStateChange]);

  // ── Autoscroll to bottom on new message / streaming chunk ──
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── Send handler ──
  const handleSend = () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    void sendMessage({ text });
  };

  // ── On unmount, fire LLM-digest compaction via the server endpoint. ──
  // The server holds the OpenRouter key; we just ship the transcript.
  // Captures the latest messages via ref so the cleanup uses fresh data.
  const messagesRef = useRef<typeof messages>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      const list = messagesRef.current;
      if (!list || list.length === 0) return;

      const transcript = list.map((m) => ({
        role: m.role,
        content: messageText(m.parts),
      }));

      // Server route does the LLM digest + Convex compactSession write.
      // beacon-style: fire-and-forget; keepalive lets the request survive
      // tab teardown. Falls back to naive client-side compaction if the
      // endpoint fails or is unreachable.
      const payload = JSON.stringify({ sessionId, messages: transcript });
      fetch('/api/walle/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {
        // Fallback: naive count summary written directly from the client.
        const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
        if (!convexUrl) return;
        try {
          const client = new ConvexHttpClient(convexUrl);
          void client.mutation(api.dashboard_chat.compactSession, {
            thread_id: 'walle',
            session_id: sessionId,
            summary: `Previous session: ${list.length} messages.`,
          });
        } catch {
          // best-effort
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render — merge AI-SDK messages with locally-injected jokes,
  //          chronological by index/createdAt, take last ~10. ──
  type Visible =
    | { kind: 'chat'; id: string; role: 'user' | 'assistant' | 'system'; text: string; isJoke?: false }
    | { kind: 'joke'; id: string; role: 'assistant'; text: string; createdAt: number; isJoke: true };

  const chatVisible: Visible[] = messages.map((m) => ({
    kind: 'chat',
    id: m.id,
    role: m.role as 'user' | 'assistant' | 'system',
    text: messageText(m.parts),
  }));
  const jokesVisible: Visible[] = jokeMessages.map((j) => ({
    kind: 'joke',
    id: j.id,
    role: 'assistant',
    text: j.text,
    createdAt: j.createdAt,
    isJoke: true as const,
  }));
  // Append jokes after chat in arrival order (jokes only fire while idle,
  // so trailing them is correct without per-event timestamps on chat msgs).
  const visible = [...chatVisible, ...jokesVisible].slice(-10);

  return (
    <div className="flex h-full min-h-[320px] flex-col rounded-xl border border-white/5 bg-zinc-950/60 text-zinc-100">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
        aria-label="WallE chat history"
      >
        {visible.length === 0 ? (
          <p className="select-none text-sm text-zinc-500">
            Ask WallE about your rentals…
          </p>
        ) : (
          visible.map((m) => {
            const mine = m.role === 'user';
            const isJoke = m.kind === 'joke';
            return (
              <div
                key={m.id}
                className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  data-walle-joke={isJoke ? '1' : undefined}
                  className={[
                    'max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-snug',
                    mine
                      ? 'bg-indigo-500/20 text-indigo-100'
                      : isJoke
                        ? 'bg-white/5 italic text-zinc-400'
                        : 'bg-white/5 text-zinc-100',
                  ].join(' ')}
                >
                  {m.text || (m.role === 'assistant' && isThinking ? '…' : '')}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-white/5 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              bumpActivity();
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              bumpActivity();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder="Message WallE…"
            className="flex-1 resize-none rounded-md border border-white/10 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isThinking || input.trim().length === 0}
            className="rounded-md bg-indigo-500/80 px-3 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-indigo-500"
          >
            {isThinking ? 'Thinking…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Convenience hook for any caller that doesn't want to use the callback
 * prop. Wraps the component's derived `chatState` in local state and a
 * setter exposed by the component prop. Phase 8 can either use this or
 * the prop directly.
 */
export function useWallEChatState(): [
  WallEChatState,
  (next: WallEChatState) => void,
] {
  const [state, setState] = useState<WallEChatState>('idle');
  return [state, setState];
}
