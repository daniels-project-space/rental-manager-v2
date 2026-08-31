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

type PushState =
  | "loading"
  | "unsupported"
  | "ios-install" // iPhone Safari tab/bookmark — must Add to Home Screen first
  | "default"
  | "denied"
  | "enabled";

type PushMode = "all" | "money_only" | "my_share";
const PUSH_MODES: readonly PushMode[] = ["all", "money_only", "my_share"];
const PUSH_MODE_STORAGE_KEY = "rental-manager:push-mode";

function storedPushMode(): PushMode | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(PUSH_MODE_STORAGE_KEY);
  return PUSH_MODES.includes(value as PushMode) ? (value as PushMode) : undefined;
}

function rememberPushMode(mode: PushMode) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(PUSH_MODE_STORAGE_KEY, mode);
  }
}

export function NotificationBell() {
  const router = useRouter();
  const vapidKey = useQuery(api.notifications.getVapidPublicKey);
  const save = useMutation(api.notifications.savePushSubscription);
  const setSubscriptionMode = useMutation(api.notifications.setPushSubscriptionMode);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const sendTest = useMutation(api.notifications.sendTestNotification);

  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<PushState>("loading");
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null);
  const [pushMode, setPushMode] = useState<PushMode>("all");
  const [modeBusy, setModeBusy] = useState(false);
  // Declared after pushMode: the device mode is an argument, so the listed
  // amounts match what this device is pushed — "My 50%" halves the bell list
  // too, not just the notification itself.
  const recent = useQuery(api.notifications.listRecent, { limit: 20, mode: pushMode });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Register the service worker + detect any existing subscription.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS Safari standalone flag
      window.navigator?.standalone === true;
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      // iPhone in a Safari tab/bookmark can't do web push until the site is
      // added to the Home Screen (Apple restriction) — guide there instead of
      // a dead "unsupported".
      queueMicrotask(() =>
        setPushState(isIOS && !isStandalone ? "ios-install" : "unsupported"),
      );
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          setPushEndpoint(sub.endpoint);
          setPushState("enabled");
        }
        else setPushState(Notification.permission === "denied" ? "denied" : "default");
      })
      .catch(() =>
        setPushState(Notification.permission === "denied" ? "denied" : "default"),
      );
  }, []);

  // Keep push alive so notifications never silently expire. Whenever the app
  // loads with permission already granted, re-attach the subscription — RE-
  // subscribing if the browser has dropped/rotated it — and re-save it.
  // savePushSubscription upserts by endpoint (refreshes last_seen), so this is
  // idempotent and won't duplicate. This is the reliable cross-platform heal;
  // iOS doesn't fire `pushsubscriptionchange`, so we refresh on every open.
  useEffect(() => {
    if (typeof window === "undefined" || !vapidKey) return;
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    )
      return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
          });
        }
        if (cancelled) return;
        const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
        const result = await save({
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          // Refreshing an existing subscription must not overwrite a mode the
          // operator changed elsewhere (for example, restoring All updates
          // after a money-only setting suppressed an urgent rate alert). Only
          // the explicit mode buttons below are allowed to change the server
          // preference.
          user_agent: navigator.userAgent,
        });
        if (!cancelled) {
          setPushEndpoint(sub.endpoint);
          setPushMode(result.mode);
          rememberPushMode(result.mode);
          setPushState("enabled");
        }
      } catch {
        /* best-effort keep-alive; the manual Enable button is the fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidKey, save]);

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
      const result = await save({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        mode: storedPushMode(),
        user_agent: navigator.userAgent,
      });
      setPushEndpoint(sub.endpoint);
      setPushMode(result.mode);
      rememberPushMode(result.mode);
      setPushState("enabled");
    } catch (e) {
      setErr((e as Error).message || "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function changePushMode(next: PushMode) {
    if (!pushEndpoint || next === pushMode) return;
    setErr(null);
    setModeBusy(true);
    try {
      const result = await setSubscriptionMode({ endpoint: pushEndpoint, mode: next });
      setPushMode(result.mode);
      rememberPushMode(result.mode);
    } catch (e) {
      setErr((e as Error).message || "Could not update this device's notification mode.");
    } finally {
      setModeBusy(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && (recent?.unread ?? 0) > 0) markAllRead({}).catch(() => {});
  }

  function openThread(url: string) {
    setOpen(false);
    // Tell any open widget chat modal to yield, so the deep-link host is the only
    // chat that shows the thread I clicked (never a stale old tile behind it).
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("rm-deeplink"));
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
          {pushState !== "enabled" && pushState !== "loading" && (
            <div className="p-3 border-b border-white/10">
              {pushState === "ios-install" ? (
                <>
                  <p className="text-[11px] text-[#e4e6eb] font-semibold mb-1">
                    📲 Add to Home Screen for notifications
                  </p>
                  <p className="text-[10px] text-[#9aa0ad] leading-snug">
                    iPhone only allows app notifications from a Home-Screen app
                    (a Safari bookmark can&apos;t). Tap{" "}
                    <b>Share</b> → <b>Add to Home Screen</b>, open{" "}
                    <b>Rentals</b> from your home screen, then tap this bell →{" "}
                    <b>Enable</b>.
                  </p>
                  <p className="text-[10px] text-emerald-400/90 mt-2 leading-snug">
                    ✅ Meanwhile you&apos;re already getting these on Telegram —
                    no install needed.
                  </p>
                </>
              ) : pushState === "unsupported" ? (
                <p className="text-[11px] text-[#8b8fa3]">
                  This browser doesn&apos;t support push. You&apos;re still
                  getting notifications on Telegram.
                </p>
              ) : pushState === "denied" ? (
                <p className="text-[11px] text-amber-400">
                  Notifications are blocked — enable them for this site in your
                  browser settings, then reopen. (Telegram still works.)
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
            <div className="px-3 py-2.5 border-b border-white/10 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-emerald-400">
                  ✓ Phone notifications on
                </span>
                <button
                  onClick={() => sendTest({}).catch(() => {})}
                  className="text-[10px] text-[#9aa0ad] hover:text-[#e4e6eb] underline-offset-2 hover:underline"
                >
                  Send money test
                </button>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.12em] text-[#6b7280] mb-1.5">
                  This device
                </p>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-1">
                  {([
                    ["all", "All notifications"],
                    ["money_only", "Money only"],
                    ["my_share", "My 50%"],
                  ] as const).map(([mode, label]) => {
                    const selected = pushMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={selected}
                        disabled={modeBusy}
                        onClick={() => void changePushMode(mode)}
                        className="rounded-md px-2 py-1.5 text-[10px] font-semibold transition-colors disabled:opacity-50"
                        style={{
                          color: selected
                            ? mode === "money_only"
                              ? "#fbbf24"
                              : mode === "my_share"
                                ? "#34d399"
                                : "#e4e6eb"
                            : "#7a8190",
                          background: selected ? "rgba(255,255,255,0.09)" : "transparent",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[9px] text-[#6b7280] mt-1.5 leading-snug">
                  All notifications shows every rental alert. Money only sends confirmed-rental “Wohoo” earnings alerts. My 50% sends the same alerts showing half the earnings — your share. Other devices keep their own setting.
                </p>
                {err && <p className="text-[10px] text-red-400 mt-1">{err}</p>}
              </div>
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
                    {e.type === "booking_confirmed" ? "🎉" : e.type === "low_response_rate" ? "🚨" : "🔔"}
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
