"use client";
import { useState } from "react";
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { money } from "./BusinessPayoutCalculator";
export function InvoiceArchive() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.invoices.list,
    {},
    { initialNumItems: 30 },
  );
  const stats = useQuery(api.invoices.stats, {});
  const sync = useAction(api.invoice_sync.syncNow);
  const retry = useMutation(api.invoices.retry);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState("all");
  const [search, setSearch] = useState("");
  const [pdf, setPdf] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      setMessage(success);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <p className="text-sm text-white/60 max-w-2xl">
          Original Hygglo invoices from every connected account. New invoices
          are discovered daily; the initial backfill runs in small batches.
          Statistics include reconciled GBP invoices and show actual extracted
          figures and how many invoices disclose each amount.
        </p>
        <button
          className="rounded-lg border border-white/20 px-4 py-2 text-sm"
          disabled={busy}
          onClick={() =>
            void run(() => sync({}), "Discovery queued for all accounts.")
          }
        >
          Sync all accounts
        </button>
      </div>
      {message && (
        <p role="status" className="text-sm bg-white/5 rounded-lg p-3">
          {message}
        </p>
      )}
      {!stats && <p>Loading statistics…</p>}
      {stats &&
        Object.entries(stats.groups).map(([slug, g]) => (
          <div
            className="rounded-xl border border-white/15 p-4 space-y-3"
            key={slug}
          >
            <div className="flex justify-between">
              <h3 className="font-semibold capitalize">{slug}</h3>
              <p className="text-xs text-white/60">
                {g.count} invoices · {g.ready} parsed · {g.review} review ·{" "}
                {g.queued} queued · {g.failed} failed
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                ["Rental revenue", g.revenue, g.revenueKnown],
                ["Our lender commission", g.lenderFee, g.lenderKnown],
                ["Renter-side fee", g.renterFee, g.renterKnown],
                ["Net payout", g.payout, g.payoutKnown],
              ].map(([name, value, count]) => (
                <div key={String(name)}>
                  <p className="text-xs text-white/50">{name}</p>
                  <p className="text-xl font-semibold">
                    {Number(count) ? money(Number(value)) : "Not disclosed"}
                  </p>
                  <p className="text-xs text-white/50">
                    {count} / {g.count} disclose this
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-white/50">
              Known Hygglo fees: {money(g.lenderFee + g.renterFee)}. A complete
              total requires both sides to be disclosed. Revenue and payout are
              separate figures.
            </p>
          </div>
        ))}
      {stats && !Object.keys(stats.groups).length && (
        <p className="rounded-xl bg-white/5 p-5">
          No invoices yet. Sync all accounts to start the PDF backfill.
        </p>
      )}
      <div className="flex gap-3">
        <label className="text-sm">
          Account
          <select
            className="ml-2 bg-slate-900 border border-white/20 rounded-lg p-2"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="all">All accounts</option>
            {stats &&
              Object.keys(stats.groups).map((a) => (
                <option key={a}>{a}</option>
              ))}
          </select>
        </label>
        <input
          aria-label="Search loaded invoices"
          className="bg-white/5 border border-white/20 rounded-lg p-2 text-sm flex-1"
          placeholder="Search loaded invoice ID or equipment"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        {results
          .filter(
            (r) =>
              (account === "all" || r.account_slug === account) &&
              (!search ||
                `${r.source_id} ${r.title}`
                  .toLowerCase()
                  .includes(search.toLowerCase())),
          )
          .map((r) => (
            <article
              className="rounded-lg border border-white/10 p-3 text-sm"
              key={r._id}
            >
              <div className="flex justify-between gap-3">
                <div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-xs text-white/50">
                    {r.account_slug} · #{r.source_id} · {r.date.slice(0, 10)} ·{" "}
                    {r.price_label}
                  </p>
                </div>
                <span className="text-xs">{r.status}</span>
              </div>
              <div className="flex flex-wrap gap-3 mt-2">
                {r.pdfUrl && (
                  <>
                    <button
                      className="underline"
                      onClick={() => {
                        setPdf(r.pdfUrl);
                        setText(null);
                      }}
                    >
                      View PDF
                    </button>
                    <button
                      className="underline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const response = await fetch(r.pdfUrl!);
                          if (!response.ok) throw Error("PDF download failed");
                          const blob = await response.blob();
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = `${r.account_slug}-${r.source_id}.pdf`;
                          document.body.appendChild(link);
                          link.click();
                          link.remove();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }, "Original PDF downloaded.")
                      }
                    >
                      Download PDF
                    </button>
                  </>
                )}
                {r.textUrl && (
                  <button
                    className="underline"
                    onClick={() =>
                      void run(async () => {
                        const response = await fetch(r.textUrl!);
                        if (!response.ok) throw Error("Text unavailable");
                        setText(await response.text());
                        setPdf(null);
                      }, "Saved text opened.")
                    }
                  >
                    View saved text
                  </button>
                )}
                {r.status === "failed" || r.status === "review" ? (
                  <button
                    disabled={busy}
                    className="underline"
                    onClick={() =>
                      void run(() => retry({ id: r._id }), "Retry queued.")
                    }
                  >
                    Retry extraction
                  </button>
                ) : null}
              </div>
              {r.error && <p className="text-amber-200 mt-2">{r.error}</p>}
              {r.amounts && (
                <p className="text-xs text-white/60 mt-2">
                  Revenue{" "}
                  {r.amounts.revenue === undefined
                    ? "unknown"
                    : money(r.amounts.revenue)}{" "}
                  · lender fee{" "}
                  {r.amounts.lender_fee === undefined
                    ? "unknown"
                    : money(r.amounts.lender_fee)}{" "}
                  · renter fee{" "}
                  {r.amounts.renter_fee === undefined
                    ? "unknown"
                    : money(r.amounts.renter_fee)}{" "}
                  · payout{" "}
                  {r.amounts.payout === undefined
                    ? "unknown"
                    : money(r.amounts.payout)}
                </p>
              )}
              <details className="text-xs text-white/40 mt-2">
                <summary>Import receipt</summary>
                <p>
                  Attempts {r.attempts} ·{" "}
                  {new Date(r.updated_at).toLocaleString()} · SHA-256{" "}
                  {r.sha256 ?? "pending"}
                </p>
              </details>
            </article>
          ))}
      </div>
      {status === "CanLoadMore" && (
        <button
          className="rounded-lg border border-white/20 px-4 py-2"
          onClick={() => loadMore(30)}
        >
          Show more invoices
        </button>
      )}
      {status === "LoadingMore" && <p>Loading…</p>}
      {(pdf || text !== null) && (
        <div className="rounded-xl border border-white/20 p-3">
          <button
            className="text-sm underline mb-3"
            onClick={() => {
              setPdf(null);
              setText(null);
            }}
          >
            Close document
          </button>
          {pdf ? (
            <iframe
              title="Original invoice PDF"
              src={pdf}
              className="w-full h-[65dvh] bg-white rounded-lg"
            />
          ) : (
            <pre className="text-xs whitespace-pre-wrap max-h-[60dvh] overflow-auto">
              {text}
            </pre>
          )}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm">Import log</summary>
        <div className="text-xs space-y-2 mt-3">
          {stats?.logs.map((l) => (
            <p key={l._id}>
              {new Date(l.created_at).toLocaleString()} · {l.account_slug} ·{" "}
              {l.message}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
