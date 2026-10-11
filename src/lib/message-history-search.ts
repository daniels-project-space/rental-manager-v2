export type HistoryRequest = {
  thread_id: string;
  booking_id?: string;
  terms: string[];
  cursor: string | null;
};
export type HistoryPage = {
  thread_id: string;
  remaining: string[];
  done: boolean;
  cursor: string | null;
  scanned: number;
  error?: string;
};
export async function searchMessageHistory(
  requests: HistoryRequest[],
  read: (args: {
    requests: HistoryRequest[];
  }) => Promise<{ results: HistoryPage[] }>,
  progress: (matches: string[], pending: boolean, error: string | null) => void,
  cancelled: () => boolean,
) {
  const pending = requests.map((request) => ({
    ...request,
    terms: [...request.terms],
  }));
  const matches = new Set<string>();
  const errors = new Set<string>();
  while (pending.length && !cancelled()) {
    const chunk = pending.splice(0, 16);
    const response = await read({ requests: chunk });
    if (cancelled()) return;
    for (const request of chunk) {
      const result = response.results.find(
        (result) => result.thread_id === request.thread_id,
      );
      if (
        !result ||
        result.remaining.some((term) => !request.terms.includes(term))
      )
        throw Error("Message search returned an incomplete page.");
      if (result.error) errors.add(result.error);
      else if (!result.remaining.length) matches.add(request.thread_id);
      else if (!result.done) {
        if (!result.cursor || result.cursor === request.cursor)
          throw Error("Message search could not advance to the next page.");
        pending.push({
          ...request,
          terms: result.remaining,
          cursor: result.cursor,
        });
      }
    }
    progress([...matches], pending.length > 0, [...errors].join(" ") || null);
  }
}
