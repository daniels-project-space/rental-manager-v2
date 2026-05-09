"use client";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { useRef, useState, useEffect } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function AIChat() {
  const sendStub = useAction(api.chat.sendStub);

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");

    const userMsg: Message = { role: "user", content: text, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    try {
      const reply = await sendStub({ message: text });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply, ts: Date.now() },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong. Please try again.", ts: Date.now() },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleClear() {
    setMessages([]);
    setDraft("");
  }

  return (
    <div style={{ minHeight: "420px" }}><Card className="flex flex-col">
      <CardHeader
        title="AI Assistant"
        badge={
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}
          >
            Shell — Phase 5.6
          </span>
        }
        actions={
          messages.length > 0 ? (
            <button
              onClick={handleClear}
              className="text-xs px-2 py-1 rounded transition-colors"
              style={{ color: "#8b8fa3", background: "rgba(255,255,255,0.05)" }}
            >
              Clear
            </button>
          ) : null
        }
      />

      {/* Message area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 mb-3 pr-1"
        style={{ minHeight: 220, maxHeight: 320 }}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-center" style={{ color: "#8b8fa3" }}>
              Ask about your rentals, revenue, or inventory.
              <br />
              <span style={{ color: "rgba(139,143,163,0.5)", fontSize: "0.7rem" }}>
                Full AI agent launches in phase 5.6
              </span>
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={i}
              className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
            >
              <div
                className="max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed"
                style={
                  isUser
                    ? { background: "#6ea8fe", color: "#070910", borderRadius: "16px 16px 4px 16px" }
                    : {
                        background: "rgba(14,17,28,0.85)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        color: "#e4e6eb",
                        borderRadius: "16px 16px 16px 4px",
                      }
                }
              >
                {msg.content}
              </div>
              <span className="text-xs px-1" style={{ color: "#8b8fa3" }}>
                {formatTime(msg.ts)}
              </span>
            </div>
          );
        })}

        {sending && (
          <div className="flex items-start">
            <div
              className="px-4 py-3 rounded-2xl"
              style={{
                background: "rgba(14,17,28,0.85)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "16px 16px 16px 4px",
              }}
            >
              <span className="flex gap-1 items-center" style={{ color: "#8b8fa3" }}>
                <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 rounded-full animate-bounce bg-current" style={{ animationDelay: "300ms" }} />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        className="flex gap-2 pt-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask a question… (Enter to send)"
          rows={2}
          disabled={sending}
          className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none transition-colors disabled:opacity-50"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#e4e6eb",
            lineHeight: 1.5,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!draft.trim() || sending}
          className="px-4 rounded-xl font-medium text-sm transition-colors disabled:opacity-40 self-end pb-2"
          style={{ background: "#6ea8fe", color: "#070910", height: 68 }}
        >
          Send
        </button>
      </div>
    </Card></div>
  );
}
