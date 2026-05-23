"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { useRef, useState, useEffect, useCallback } from "react";

type PersistedMessage = {
  _id: string;
  role: string;
  content: string;
  created_at: number;
};

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function AIChat() {
  const messages = useQuery(api.dashboard_chat.getMessages, {
    thread_id: "dashboard",
    limit: 50,
  });
  const clearThread = useMutation(api.dashboard_chat.clearThread);

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamDraft, setStreamDraft] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  // Optimistic user-message buffer — shown instantly on send so the user
  // never wonders "where did my question go?" while we wait for the Convex
  // sync that eventually persists it. Cleared once the persisted row arrives.
  const [optimisticUser, setOptimisticUser] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamDraft, optimisticUser, scrollToBottom]);

  // Clear the local streaming bubble + optimistic user message once the
  // persisted rows arrive. A turn appends both turns, so wait for
  // messages.length to grow by >=2 from baseline.
  useEffect(() => {
    if (!streamDraft && !optimisticUser) return;
    if (streaming) return;
    const len = messages?.length ?? 0;
    if (len >= baselineCountRef.current + 2) {
      setStreamDraft("");
      setOptimisticUser("");
    }
  }, [messages, streaming, streamDraft, optimisticUser]);

  // Tracks how many persisted messages existed when the current turn started.
  // We keep the streaming bubble on screen until messages.length grows enough
  // to include the assistant's persisted row (avoids mid-stream flicker).
  const baselineCountRef = useRef<number>(0);

  async function handleSend() {
    const text = draft.trim();
    if (!text || streaming) return;
    baselineCountRef.current = messages?.length ?? 0;
    setDraft("");
    setStreaming(true);
    setStreamDraft("");
    setStreamError(null);
    setOptimisticUser(text);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, thread_id: "dashboard" }),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") ?? "60";
        setStreamError("Rate limit reached. Try again in " + retryAfter + "s.");
        setStreamDraft("");
        return;
      }

      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          // [DONE] signals end-of-stream — do NOT clear streamDraft here; a
          // useEffect below clears it once the persisted assistant message
          // lands in `messages`, so the bubble never vanishes mid-flight.
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload) as { text?: string; error?: string };
            if (parsed.error) {
              setStreamError(parsed.error);
            } else if (parsed.text) {
              setStreamDraft((prev) => prev + parsed.text);
            }
          } catch { /* ignore malformed chunk */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[AIChat] stream error:", err);
      setStreamError("Connection error: " + msg);
      setStreamDraft("");
      setOptimisticUser("");
    } finally {
      setStreaming(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  async function handleClear() {
    await clearThread({ thread_id: "dashboard" });
    setStreamDraft("");
    setStreamError(null);
    setOptimisticUser("");
  }

  const hasHistory = (messages?.length ?? 0) > 0;
  const lastMsg = messages?.[messages.length - 1];
  const lastIsSystemError = lastMsg?.role === "system" && lastMsg.content.startsWith("Error:");

  return (
    <div style={{ minHeight: "420px" }}>
      <Card className="flex flex-col">
        <CardHeader
          title="AI Assistant"
          badge={
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}>
              DeepSeek · 10 tools · build-v3
            </span>
          }
          actions={
            hasHistory || streaming ? (
              <button onClick={() => void handleClear()} className="text-xs px-2 py-1 rounded transition-colors" style={{ color: "#8b8fa3", background: "rgba(255,255,255,0.05)" }}>
                Clear
              </button>
            ) : null
          }
        />

        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 mb-3 pr-1" style={{ minHeight: 220, maxHeight: 320 }}>
          {!hasHistory && !streaming && !streamDraft && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-center" style={{ color: "#8b8fa3" }}>
                Ask about rentals, calendar, pricing, or compatibility — I have full context.
              </p>
            </div>
          )}

          {(messages ?? []).map((msg: PersistedMessage) => {
            const isUser = msg.role === "user";
            const isSystemError = msg.role === "system" && msg.content.startsWith("Error:");
            if (isSystemError) {
              return (
                <div key={msg._id} className="flex flex-col gap-1 items-start">
                  <div className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed" style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#fca5a5", borderRadius: "16px 16px 16px 4px" }}>
                    <span className="inline-block text-xs font-semibold mr-1 px-1.5 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.25)", color: "#f87171" }}>error</span>{" "}{msg.content.replace(/^Error:\s*/, "")}
                  </div>
                  <span className="text-xs px-1" style={{ color: "#8b8fa3" }}>{formatTime(msg.created_at)}</span>
                </div>
              );
            }
            return (
              <div key={msg._id} className={"flex flex-col gap-1 " + (isUser ? "items-end" : "items-start")}>
                <div
                  className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
                  style={isUser
                    ? { background: "#6ea8fe", color: "#070910", borderRadius: "16px 16px 4px 16px" }
                    : { background: "rgba(14,17,28,0.85)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb", borderRadius: "16px 16px 16px 4px" }
                  }
                >
                  {msg.content}
                </div>
                <span className="text-xs px-1" style={{ color: "#8b8fa3" }}>{formatTime(msg.created_at)}</span>
              </div>
            );
          })}

          {lastIsSystemError && !streaming && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#fca5a5" }}>
              <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: "#ef4444" }} />
              Something went wrong with the last request. Try resending.
            </div>
          )}

          {streamError && !streaming && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#fca5a5" }}>
              <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: "#ef4444" }} />
              {streamError}
            </div>
          )}

          {optimisticUser && (
            <div className="flex flex-col gap-1 items-end">
              <div
                className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
                style={{ background: "#6ea8fe", color: "#070910", borderRadius: "16px 16px 4px 16px" }}
              >
                {optimisticUser}
              </div>
              <span className="text-xs px-1" style={{ color: "#8b8fa3" }}>sending…</span>
            </div>
          )}

          {(streaming || streamDraft) && (
            <div className="flex flex-col gap-1 items-start">
              <div className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap" style={{ background: "rgba(14,17,28,0.85)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb", borderRadius: "16px 16px 16px 4px" }}>
                {streamDraft || (
                  <span className="flex gap-1.5 items-center" style={{ color: "#8b8fa3" }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "300ms" }} />
                    <span className="text-xs ml-1">thinking…</span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask a question… (Enter to send)"
            rows={2}
            disabled={streaming}
            className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none transition-colors disabled:opacity-50"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb", lineHeight: 1.5 }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={!draft.trim() || streaming}
            className="px-4 rounded-xl font-medium text-sm transition-colors disabled:opacity-40 self-end pb-2"
            style={{ background: "#6ea8fe", color: "#070910", height: 68 }}
          >
            {streaming ? "..." : "Send"}
          </button>
        </div>
      </Card>
    </div>
  );
}
