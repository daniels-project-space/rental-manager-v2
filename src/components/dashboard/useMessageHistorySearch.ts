"use client";
import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  searchMessageHistory,
  type HistoryRequest,
} from "../../lib/message-history-search";
export function useMessageHistorySearch(requests: HistoryRequest[]) {
  const read = useAction(
    makeFunctionReference<"action">("quick_reply_search:page"),
  );
  const key = JSON.stringify(requests);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({
    key: "[]",
    matches: [] as string[],
    pending: false,
    error: null as string | null,
  });
  useEffect(() => {
    const snapshot: HistoryRequest[] = JSON.parse(key);
    let cancelled = false;
    setState({ key, matches: [], pending: snapshot.length > 0, error: null });
    if (!snapshot.length) return;
    const timer = setTimeout(() => {
      void searchMessageHistory(
        snapshot,
        read,
        (matches, pending, error) => {
          if (!cancelled) setState({ key, matches, pending, error });
        },
        () => cancelled,
      ).catch((error) => {
        if (!cancelled)
          setState((previous) => ({
            ...previous,
            key,
            pending: false,
            error:
              error instanceof Error
                ? error.message
                : "Message history is unavailable.",
          }));
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, read, retry]);
  return {
    matches: new Set(state.key === key ? state.matches : []),
    pending: requests.length > 0 && (state.key !== key || state.pending),
    error: state.key === key ? state.error : null,
    retry: () => setRetry((value) => value + 1),
  };
}
