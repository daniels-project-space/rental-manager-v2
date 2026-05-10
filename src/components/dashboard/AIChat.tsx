"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { useRef, useState, useEffect } from "react";

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamDraft]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreaming(true);
    setStreamDraft("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, thread_id: "dashboard" }),
      });

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
          if (payload === "[DONE]") { setStreamDraft(""); break; }
          try {
            const parsed = JSON.parse(payload) as { text: string };
            setStreamDraft((prev) => prev + parsed.text);
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error("[AIChat] stream error:", err);
    } finally {
      setStreaming(false);
      setStreamDraft("");
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  async function handleClear() {
    await clearThread({ thread_id: "dashboard" });
    setStreamDraft("");
  }

  const hasHistory = (messages?.length ?? 0) > 0;

  return (
    <div style={{ minHeight: "420px" }}>
      <Card className="flex flex-col">
        <CardHeader
          title="AI Assistant"
          badge={
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}>
              Grok 4.1 Fast
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
                Ask about your rentals, revenue, or inventory.
              </p>
            </div>
          )}

          {(messages ?? []).map((msg: PersistedMessage) => {
            const isUser = msg.role === "user";
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

          {(streaming || streamDraft) && (
            <div className="flex flex-col gap-1 items-start">
              <div className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap" style={{ background: "rgba(14,17,28,0.85)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb", borderRadius: "16px 16px 16px 4px" }}>
                {streamDraft || (
                  <span className="flex gap-1 items-center" style={{ color: "#8b8fa3" }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "300ms" }} />
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
            Send
          </button>
        </div>
      </Card>
    </div>
  );
}
