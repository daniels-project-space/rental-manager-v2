"use client";
/**
 * Notification deep-link host (2026-06-23). Reads `?thread=<id>` from the URL
 * (set by a tapped push / Telegram button or the bell dropdown), fetches that
 * thread's tile, and opens the Reply modal OVER everything (z-[300]) — so a
 * tapped notification always wins, even if a chat was already open. Mount inside
 * a <Suspense> (useSearchParams requirement).
 *
 * 2026-06-27: also listens for the service worker's `deep-link` postMessage. On
 * iOS PWAs WindowClient.navigate() frequently no-ops, so a tapped push wouldn't
 * change the URL and the chat wouldn't open — the message path routes reliably.
 */
import { useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ReplyModal, type ReplyTileData } from "./ReplyInbox";

export function NotificationDeepLink() {
  const params = useSearchParams();
  const router = useRouter();
  const threadId = params.get("thread");

  // Reliable routing from the SW (covers iOS, where client.navigate() no-ops).
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | undefined;
      if (d?.type === "deep-link" && typeof d.url === "string") {
        router.replace(d.url, { scroll: false });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [router]);

  const tileLive = useQuery(
    api.replyInbox.getThreadById,
    threadId ? { thread_id: threadId } : "skip",
  ) as unknown as ReplyTileData | null | undefined;

  // Keep the modal open after approve/decline/send drop the thread out of
  // getThreadById — cache the last row for THIS thread and fall back to it, so
  // it closes only via × (which clears ?thread=). Mirrors the widget's fix.
  const tileCacheRef = useRef<{ id: string; tile: ReplyTileData } | null>(null);
  if (tileLive && threadId) tileCacheRef.current = { id: threadId, tile: tileLive };
  const tile =
    tileLive ??
    (tileCacheRef.current?.id === threadId ? tileCacheRef.current.tile : null);

  if (!threadId) return null;
  if (!tile) return null; // loading / not found

  const close = () => router.replace("/", { scroll: false });
  // onActed = no-op so approve/decline keeps the chat open (close only via ×),
  // matching the widget. zClass z-[300] keeps it above any open widget modal.
  return (
    <ReplyModal
      key={threadId}
      tile={tile}
      onClose={close}
      onActed={() => {}}
      dryRun={false}
      zClass="z-[300]"
    />
  );
}
