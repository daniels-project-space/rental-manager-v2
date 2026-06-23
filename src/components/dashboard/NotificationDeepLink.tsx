"use client";
/**
 * Notification deep-link host (2026-06-23). Reads `?thread=<id>` from the URL
 * (set by a tapped push / Telegram button or the bell dropdown), fetches that
 * thread's tile, and opens the Reply modal over the dashboard — regardless of
 * whether the Reply Inbox widget is mounted/scrolled into view. Closing clears
 * the param. Mount inside a <Suspense> (useSearchParams requirement).
 */
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ReplyModal, type ReplyTileData } from "./ReplyInbox";

export function NotificationDeepLink() {
  const params = useSearchParams();
  const router = useRouter();
  const threadId = params.get("thread");

  const tile = useQuery(
    api.replyInbox.getThreadById,
    threadId ? { thread_id: threadId } : "skip",
  ) as unknown as ReplyTileData | null | undefined;

  if (!threadId) return null;
  if (tile === undefined || tile === null) return null; // loading / not found

  const close = () => router.replace("/", { scroll: false });
  return <ReplyModal tile={tile} onClose={close} onActed={close} />;
}
