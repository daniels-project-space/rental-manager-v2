"use client";
/** Notification navigation delegates to the inbox's single conversation owner. */
import { useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export function NotificationDeepLink() {
  const params = useSearchParams();
  const router = useRouter();
  const threadId = params.get("thread");
  useEffect(() => {
    if (!threadId) return;
    window.dispatchEvent(new CustomEvent("rm-open-thread", { detail: threadId }));
  }, [threadId]);
  useEffect(() => {
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type !== "deep-link" || typeof data.url !== "string") return;
      const url = new URL(data.url, window.location.href);
      if (url.origin !== window.location.origin) return;
      router.replace(url.pathname + url.search, { scroll: false });
      const thread = url.searchParams.get("thread");
      if (thread) window.dispatchEvent(new CustomEvent("rm-open-thread", { detail: thread }));
    };
    serviceWorker.addEventListener("message", onMessage);
    return () => serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
  return null;
}
