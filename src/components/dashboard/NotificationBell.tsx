"use client";
/**
 * Notification bell (2026-06-23). Top-of-dashboard icon that:
 *   • enables phone push (registers the SW, requests permission, subscribes via
 *     VAPID, stores the subscription in Convex),
 *   • shows an unread badge + a dropdown of recent events (new confirmed
 *     bookings + new Reply-Hub requests),
 *   • opens the chat thread on click (router push to /?thread=…).
 *
 * Push fires server-side from the poller (convex/notifications_send.ts) for two
 * transitions: booking_confirmed ("wohoo") and new_request. Telegram is sent in
 * parallel as a fallback. iOS: web push only works once the dashboard is added
 * to the Home Screen (installed PWA) — the dropdown surfaces that hint.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { accountAccent, accountLabel } from "@/lib/account-theme";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function timeAgo(ts: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type PushState = "loading" | "unsupported" | "default" | "denied" | "enabled";

export function NotificationBell() {
  const router = useRouter();
  const vapidKey = useQuery(api.notifications.getVapidPublicKey);
  const recent = useQuery(api.notifications.listRecent, { limit: 20 });
  const save = useMutation(api.notifications.savePushSubscription);
  const markAllRead = useMutation(api.notifications.markAllRead);

  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Register the service worker + detect any existing subscription.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setPushState("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (sub) setPushState("enabled");
        else setPushState(Notification.permission === "denied" ? "denied" : "default");
      })
      .catch(() =>
        setPushState(Notification.permission === "denied" ? "denied" : "default"),
      );
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function enable() {
    setErr(null);
    if (!vapidKey) {
      setErr("Push isn't configured yet (no VAPID key).");
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState(perm === "denied" ? "denied" : "default");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
        });
      }
      const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
      await save({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        user_agent: navigator.userAgent,
      });
      setPushState("enabled");
    } catch (e) {
      setErr((e as Error).message || "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && (recent?.unread ?? 0) > 0) markAllRead({}).catch(() => {});
  }

  function openThread(url: string) {
    setOpen(false);
    router.push(url, { scroll: false });
  }

  const unread = recent?.unread ?? 0;
  const events = recent?.events ?? [];
  const isInstalledPWA =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS Safari standalone flag
      window.navigator?.standalone === true);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggleOpen}
        aria-label="Notifications"
        title="Notifications"
        className="relative text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors text-base leading-none"
      >
        <span className="text-[17px]">🔔</span>
        {unread > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center"
            style={{ background: "#ef4444", color: "#fff" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        {pushState === "enabled" && unread === 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
            style={{ background: "#22c55e", boxShadow: "0 0 6px #22c55e" }}
          />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-[330px] max-h-[70vh] overflow-hidden flex flex-col rounded-xl border shadow-2xl z-50"
          style={{ background: "#101216", borderColor: "rgba(255,255,255,0.1)" }}
        >
          {/* Enable / status banner */}
          {pushState !== "enabled" && (
            <div className="p-3 border-b border-white/10">
              {pushState === "unsupported" ? (
                <p className="text-[11px] text-[#8b8fa3]">
                  This browser doesn&apos;t support push notifications.
                </p>
              ) : pushState === "denied" ? (
                <p className="text-[11px] text-amber-400">
                  Notifications are blocked — enable them for this site in your
                  browser settings, then reopen.
                </p>
              ) : (
                <>
                  <button
                    onClick={enable}
                    disabled={busy}
                    className="w-full text-xs font-semibold px-3 py-2 rounded-lg text-white disabled:opacity-50"
                    style={{ background: "#a855f7" }}
                  >
                    {busy ? "Enabling…" : "🔔 Enable phone notifications"}
                  </button>
                  <p className="text-[10px] text-[#6b7280] mt-1.5 leading-snug">
                    Get a push for every new confirmed booking and new request.
                    {!isInstalledPWA && (
                      <> On iPhone: Share → <b>Add to Home Screen</b> first.</>
                    )}
                  </p>
                  {err && <p className="text-[10px] text-red-400 mt-1">{err}</p>}
                </>
              )}
            </div>
          )}
          {pushState === "enabled" && (
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
              <span className="text-[11px] text-emerald-400">
                ✓ Phone notifications on
              </span>
              <span className="text-[10px] text-[#6b7280]">Recent</span>
            </div>
          )}

          {/* Event list */}
          <div className="overflow-y-auto">
            {events.length === 0 ? (
              <div className="p-5 text-center text-[11px] text-[#6b7280]">
                No notifications yet.
              </div>
            ) : (
              events.map((e) => (
                <button
                  key={e._id}
                  onClick={() => openThread(e.url)}
                  className="w-full text-left px-3 py-2.5 border-b border-white/[0.06] hover:bg-white/[0.04] transition-colors flex gap-2.5"
                >
                  <span className="text-base leading-none mt-0.5">
                    {e.type === "booking_confirmed" ? "🎉" : "🔔"}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-[#e4e6eb] truncate">
                        {e.title.replace(/^[^\w]+\s*/, "")}
                      </span>
                      {e.read_at === undefined && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#a855f7] shrink-0" />
                      )}
                      <span className="ml-auto text-[10px] text-[#6b7280] shrink-0">
                        {timeAgo(e.created_at)}
                      </span>
                    </span>
                    <span className="block text-[11px] text-[#9aa0ad] truncate mt-0.5">
                      {e.body}
                    </span>
                    {e.account_slug && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[10px] text-[#7a8190]">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: accountAccent(e.account_slug) }}
                        />
                        {accountLabel(e.account_slug)}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
