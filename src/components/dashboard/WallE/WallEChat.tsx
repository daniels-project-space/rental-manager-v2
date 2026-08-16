/**
 * WallEChat — Option C layout: character-hosted chat with head-tethered bubble.
 *
 * Layout:
 *   Top:     <slot> for character + LATEST assistant message rendered as a
 *            head-tethered speech bubble (parent renders the bot in the slot).
 *   Middle:  scroll area with OLDER messages — assistant messages get a tiny
 *            WallE-face avatar + speech-bubble styling; user messages are
 *            right-aligned rounded bubbles. AnimatePresence drives enter/exit
 *            spring-physics; `layout` prop reflows smoothly.
 *   Bottom:  textarea + Send.
 *
 * Mood/speaking signals:
 *   - onChatStateChange fires (idle | listening | thinking) for parent mood.
 *   - onSpeakingChange fires when a *new* assistant turn arrived in the last
 *     2.4s so the parent can lean WallE forward.
 *
 * Idle jokes still load locally and render in the bubble queue.
 */
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { WallEChatState } from './walle.types';
import { JOKE_IDLE_AFTER_MS } from './walle.jokes';
import type { BubbleTone } from './WallESpeechBubble';

export interface WallEChatProps {
  /**
   * Called whenever the derived chat state changes. The parent shell feeds
   * this into the mood reducer.
   */
  onChatStateChange?: (state: WallEChatState) => void;
  /** Called true when a fresh assistant message arrived in the last ~2.4s. */
  onSpeakingChange?: (speaking: boolean) => void;
  /**
   * Optional — dashboard-signal updates reset the idle timer so jokes don't
   * fire on top of fresh alerts.
   */
  lastSignalChangeAt?: number;
  /** Slot rendered at the top-left of the chat area (the character itself). */
  characterSlot?: ReactNode;
  /** Optional empty-state hint. */
  emptyHint?: string;
  /** Tighter padding/spacing for narrow inline embeds. */
  compact?: boolean;
  /** Optional className on the root container. */
  className?: string;
  /** Mood tone for the top-tethered bubble (drives color). */
  bubbleTone?: BubbleTone;
}

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

function messageText(
  parts: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  if (!parts) return '';
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/** WallE keeps a conversation for a day; both ends of that must agree. */
const WALLE_RETENTION_MS = 24 * 60 * 60 * 1000;
const WALLE_SESSION_KEY = 'walle_session';

function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `walle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reuse the stored session id while it is under 24h old, otherwise start a new
 * one. Keyed with its own timestamp rather than relying on the server, so the
 * client rolls over at the same boundary the retention sweep uses.
 */
function loadOrCreateSessionId(): string {
  if (typeof window === 'undefined') return newSessionId();
  try {
    const raw = window.localStorage.getItem(WALLE_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: string; startedAt?: number };
      if (
        parsed.id &&
        typeof parsed.startedAt === 'number' &&
        Date.now() - parsed.startedAt < WALLE_RETENTION_MS
      ) {
        return parsed.id;
      }
    }
  } catch {
    // corrupt entry — fall through and mint a fresh one
  }
  const id = newSessionId();
  try {
    window.localStorage.setItem(
      WALLE_SESSION_KEY,
      JSON.stringify({ id, startedAt: Date.now() }),
    );
  } catch {
    // private mode / quota — a per-mount id still works, just won't persist
  }
  return id;
}

/** Tiny WallE-face avatar — appears next to older assistant messages. */
function WallEMini() {
  return (
    <svg
      viewBox="0 0 40 40"
      width={26}
      height={26}
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="3" y="11" width="34" height="22" rx="6" fill="#d9b56b" />
      <rect x="3" y="11" width="34" height="5" rx="3" fill="#a48144" opacity="0.45" />
      <circle cx="14" cy="22" r="6" fill="#1a2331" />
      <circle cx="26" cy="22" r="6" fill="#1a2331" />
      <circle cx="14" cy="22" r="2.4" fill="#8ec5ff" />
      <circle cx="26" cy="22" r="2.4" fill="#8ec5ff" />
      <line x1="20" y1="11" x2="20" y2="6" stroke="#a48144" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="20" cy="5" r="1.6" fill="#8ec5ff" />
    </svg>
  );
}

export default function WallEChat({
  onChatStateChange,
  onSpeakingChange,
  lastSignalChangeAt,
  characterSlot,
  emptyHint,
  compact = false,
  className,
  bubbleTone = 'neutral',
}: WallEChatProps) {
  // Session id that SURVIVES a remount for 24h. It used to be minted fresh on
  // every mount, which (together with the destructive unmount compaction) is
  // why the conversation vanished the moment the dashboard was closed.
  // Lazy useState, not a ref: the initializer runs exactly once and, unlike the
  // previous `if (!ref.current)` pattern, does not read a ref during render
  // (react-hooks/refs).
  const [sessionId] = useState(loadOrCreateSessionId);

  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/walle/chat',
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages, sessionId },
        }),
      }),
    [sessionId],
  );

  const { messages, sendMessage, status, setMessages } = useChat({ transport });
  const isThinking = status === 'submitted' || status === 'streaming';

  // Idle-joke trigger
  const userIdRef = useRef<string>('');
  if (!userIdRef.current) userIdRef.current = getOrCreateWalleUserId();
  const lastActivityRef = useRef<number>(Date.now());
  const jokeFiredInWindowRef = useRef<boolean>(false);
  const [jokeMessages, setJokeMessages] = useState<
    Array<{ id: string; role: 'assistant'; text: string; createdAt: number; isJoke: true }>
  >([]);

  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    jokeFiredInWindowRef.current = false;
  }, []);

  useEffect(() => {
    bumpActivity();
  }, [messages, bumpActivity]);

  useEffect(() => {
    if (typeof lastSignalChangeAt === 'number') bumpActivity();
  }, [lastSignalChangeAt, bumpActivity]);

  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      if (isThinking) return;
      if (jokeFiredInWindowRef.current) return;
      if (Date.now() - lastActivityRef.current < JOKE_IDLE_AFTER_MS) return;
      jokeFiredInWindowRef.current = true;
      try {
        const res = await fetch('/api/walle/joke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: userIdRef.current }),
        });
        if (!res.ok) return;
        // Server returns { joke: string | null } (see /api/walle/joke). This
        // previously read `data.line` — always undefined, so every generated
        // joke was silently dropped and WallE never told one. (2026-06-01)
        const data: { joke?: string | null } = await res.json();
        const line = data?.joke?.trim();
        if (!line) return;
        setJokeMessages((prev) => [
          ...prev,
          {
            id: `walle-joke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            text: line,
            createdAt: Date.now(),
            isJoke: true,
          },
        ]);
      } catch {
        // best-effort
      }
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isThinking]);

  // Derived chat-state
  useEffect(() => {
    if (!onChatStateChange) return;
    let next: WallEChatState = 'idle';
    if (isThinking) next = 'thinking';
    else if (focused || input.trim().length > 0) next = 'listening';
    onChatStateChange(next);
  }, [isThinking, focused, input, onChatStateChange]);

  // Autoscroll — pin the latest question near the top so a long reply below it
  // reads from its START. (Scrolling to the absolute bottom hid long replies in
  // the bounded widget: you only saw the tail.) Falls back to bottom pre-first-turn.
  //
  // Deps are the message COUNTS, not the arrays: during streaming the assistant
  // message object grows on every token but the count is stable, so this fires
  // once per turn instead of once per token. That stops the per-token scroll
  // re-pin that (with the old layout springs) made long replies jump around —
  // the reply now just flows downward from the pinned question.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nodes = el.querySelectorAll('[data-walle-role="user"]');
    const lastUser = nodes.length ? (nodes[nodes.length - 1] as HTMLElement) : null;
    if (lastUser) {
      const offset =
        lastUser.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.max(0, offset - 8);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, jokeMessages.length]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    void sendMessage({ text });
  };

  const messagesRef = useRef<typeof messages>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Re-hydrate the last 24h of conversation on mount.
  //
  // This replaces the old unmount handler, which POSTed the transcript to
  // /api/walle/compact and had Convex DELETE every turn, leaving a single
  // "Previous session: N messages." row. Closing the dashboard therefore
  // destroyed the chat. Turns are already persisted server-side by appendTurn
  // on each reply, so nothing needs to be written on the way out — we just read
  // them back on the way in. Retention is now age-based (pruneOldTurns, 24h).
  const history = useQuery(api.dashboard_chat.getRecentTurns, {
    thread_id: 'walle',
    within_ms: WALLE_RETENTION_MS,
  });
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!history) return; // still loading
    hydratedRef.current = true;
    if (history.length === 0) return;
    // Don't clobber a turn the user managed to send before hydration landed.
    if (messagesRef.current.length > 0) return;
    setMessages(
      history.map((m) => ({
        id: String(m.id),
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        parts: [{ type: 'text' as const, text: m.content }],
      })),
    );
  }, [history, setMessages]);

  // ── Build the unified visible list ─────────────────────────────────
  type Visible = {
    kind: 'chat' | 'joke';
    id: string;
    role: 'user' | 'assistant' | 'system';
    text: string;
    isJoke?: boolean;
  };

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
    isJoke: true,
  }));
  const visible = [...chatVisible, ...jokesVisible].slice(-12);
  const hasAnyMessage = visible.length > 0;

  // 2026-05-23: Daniel asked for a normal chat scroll layout — the latest
  // exchange (one user bubble + one assistant bubble) sits at the bottom and
  // is visible by default; older turns are scrollable above. So all messages
  // flow through one list instead of the previous head-tethered split.
  const latestAssistantId = (() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].role === 'assistant') return visible[i].id;
    }
    return null;
  })();

  // Speaking detector — fresh assistant content within last 2.4s.
  const lastAssistantIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onSpeakingChange) return;
    if (latestAssistantId && latestAssistantId !== lastAssistantIdRef.current) {
      lastAssistantIdRef.current = latestAssistantId;
      onSpeakingChange(true);
      const t = window.setTimeout(() => onSpeakingChange(false), 2400);
      return () => window.clearTimeout(t);
    }
    // Streaming text — keep "speaking" true while thinking.
    if (isThinking) {
      onSpeakingChange(true);
    } else {
      onSpeakingChange(false);
    }
  }, [latestAssistantId, isThinking, onSpeakingChange]);

  // Render-helper for assistant message (left-aligned with mini-face avatar).
  function assistantBubble(m: Visible, isLatest: boolean) {
    return (
      <motion.div
        key={m.id}
        // NO `layout` here: while a long reply streams in token-by-token the
        // bubble grows on every token, and `layout` would spring-animate each
        // growth (and shove every bubble below), which read as the chat
        // "wiggling wildly". Enter/exit still animate via initial/animate/exit.
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 360, damping: 28 }}
        className="flex items-end gap-1.5 justify-start"
      >
        <WallEMini />
        <div
          data-walle-joke={m.isJoke ? '1' : undefined}
          data-walle-latest={isLatest ? '1' : undefined}
          className={[
            'relative max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-bl-md px-3 py-2 leading-snug',
            'border shadow-[0_4px_14px_rgba(0,0,0,0.35)]',
            isLatest
              ? 'text-[13px] border-white/15 bg-zinc-900/85'
              : 'text-[12.5px] border-white/10 bg-zinc-900/70',
            m.isJoke
              ? 'italic text-zinc-400'
              : 'text-zinc-100',
          ].join(' ')}
        >
          {m.text}
        </div>
      </motion.div>
    );
  }

  function userBubble(m: Visible) {
    return (
      <motion.div
        key={m.id}
        data-walle-role="user"
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 360, damping: 28 }}
        className="flex justify-end"
      >
        <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-500/25 px-3 py-2 text-[12.5px] leading-snug text-indigo-100 border border-indigo-400/30 shadow-[0_4px_14px_rgba(99,102,241,0.18)]">
          {m.text}
        </div>
      </motion.div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  //
  // Layout (Daniel-spec 2026-05-23):
  //  - The character sits pinned at top-left and stays put.
  //  - Below him, a *bounded* scroll area shows the conversation. The list
  //    auto-scrolls to the bottom on every new message, so the visible-by-
  //    default state is the latest user bubble + latest assistant bubble
  //    (one exchange). Older turns sit above and are reachable by scrolling
  //    up.
  //  - The widget never grows past the parent grid cell (h-full + max-h on
  //    the scroller plus overflow-hidden on the root).
  return (
    <div
      className={[
        'flex h-full max-h-full min-h-[260px] flex-col overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-b from-zinc-950/70 to-zinc-950/40 text-zinc-100',
        className ?? '',
      ].join(' ')}
    >
      {/* TOP — pinned character. No tethered bubble; the latest assistant
          turn now lives in the scroll list below so user + assistant
          bubbles read as one continuous chat. */}
      <div className="flex shrink-0 items-center gap-2.5 px-3 pt-2.5 pb-1.5">
        <div className="shrink-0">{characterSlot}</div>
        {!hasAnyMessage && (
          <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-zinc-400">
            {emptyHint ?? 'Ask WallE about your rentals…'}
          </div>
        )}
      </div>

      {/* MIDDLE — bounded scroll area. flex-1 + overflow-y-auto means it
          fills the leftover height inside the parent grid cell, never
          exceeding it. New messages append at the bottom and the
          scrollToBottom effect keeps the latest exchange visible. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 pt-1 pb-2"
        aria-label="WallE chat history"
      >
        <AnimatePresence initial={false}>
          {visible.map((m) =>
            m.role === 'user'
              ? userBubble(m)
              : assistantBubble(m, m.id === latestAssistantId),
          )}
          {isThinking && (
            <motion.div
              key="thinking-bubble"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-end gap-1.5 justify-start"
            >
              <WallEMini />
              <div className="rounded-2xl rounded-bl-md border border-white/10 bg-zinc-900/70 px-3 py-2">
                <ThinkingDots />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* BOTTOM — textarea + send */}
      <div
        className={[
          'border-t border-white/5 backdrop-blur-sm',
          compact ? 'px-2 py-1.5' : 'px-3 py-2',
        ].join(' ')}
      >
        <div className={['flex items-end', compact ? 'gap-1.5' : 'gap-2'].join(' ')}>
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
            className={[
              'flex-1 resize-none rounded-lg border border-white/10 bg-zinc-900/80 text-zinc-100 placeholder:text-zinc-500',
              'focus:border-indigo-400/40 focus:outline-none focus:ring-1 focus:ring-indigo-400/30 transition',
              compact ? 'px-2.5 py-1.5 text-[12.5px]' : 'px-3 py-2 text-sm',
            ].join(' ')}
          />
          <motion.button
            type="button"
            onClick={handleSend}
            disabled={isThinking || input.trim().length === 0}
            whileTap={{ scale: 0.94 }}
            className={[
              'rounded-lg font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40',
              'bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500',
              'shadow-[0_4px_12px_rgba(99,102,241,0.35)]',
              compact ? 'px-2.5 py-1.5 text-[12.5px]' : 'px-3 py-2 text-sm',
            ].join(' ')}
          >
            {isThinking ? <ThinkingDots small /> : 'Send'}
          </motion.button>
        </div>
      </div>
    </div>
  );
}

function ThinkingDots({ small = false }: { small?: boolean }) {
  const dot = small
    ? 'inline-block w-1 h-1 mx-0.5 rounded-full bg-white/80'
    : 'inline-block w-1.5 h-1.5 mx-0.5 rounded-full bg-zinc-400';
  return (
    <span className="inline-flex items-center">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={dot}
          animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.15,
          }}
        />
      ))}
    </span>
  );
}

export function useWallEChatState(): [WallEChatState, (next: WallEChatState) => void] {
  const [state, setState] = useState<WallEChatState>('idle');
  return [state, setState];
}
