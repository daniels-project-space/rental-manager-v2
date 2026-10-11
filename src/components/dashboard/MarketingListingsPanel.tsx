"use client";

import { useState } from "react";
import { useAction, usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

type Filter = "all" | "marketing" | "other";
type Draft = { marketingOnly: boolean; expectedUpdatedAt: number };

export function MarketingListingsPanel() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { results, status, loadMore } = usePaginatedQuery(
    api.hygglo_products.adminMarketingListings,
    { accountSlug: "dbcinema", search: search.trim() || undefined },
    { initialNumItems: 24 },
  );
  const saveTags = useAction(api.hygglo_products.adminSaveMarketingTags);
  const dirty = Object.keys(drafts).length;
  const visible = results.filter((item) =>
    filter === "all" || (filter === "marketing" ? item.marketingOnly : !item.marketingOnly),
  );

  async function save() {
    const changes = Object.entries(drafts).map(([productId, draft]) => ({
      productId: Number(productId),
      marketingOnly: draft.marketingOnly,
      expectedUpdatedAt: draft.expectedUpdatedAt,
    }));
    if (!changes.length) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await saveTags({ changes });
      if (result.storefrontSynced) {
        setDrafts({});
        setMessage(`Saved ${result.saved} ${result.saved === 1 ? "listing" : "listings"}; the customer basket is updated.`);
      } else {
        setDrafts({});
        setError(`Saved in Rental Manager, but the customer site did not confirm the update. The next catalogue sync will try again; check the customer basket before relying on the change. ${result.message ?? ""}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save listing tags.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(productId: number, current: boolean, updatedAt: number) {
    setMessage("");
    setError("");
    setDrafts((previous) => {
      const next = { ...previous };
      const desired = !(next[String(productId)]?.marketingOnly ?? current);
      if (desired === current) delete next[String(productId)];
      else next[String(productId)] = { marketingOnly: desired, expectedUpdatedAt: next[String(productId)]?.expectedUpdatedAt ?? updatedAt };
      return next;
    });
  }

  return (
    <section data-testid="marketing-listings-panel" className="space-y-4 rounded-2xl border border-white/10 bg-[#101114] p-4 sm:p-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">Catalogue controls</p>
          <h2 className="mt-1 text-xl font-semibold text-white">Marketing-only listings</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">
            Keep a listing visible for browsing and demand tracking while showing it as unavailable in the basket. Saved tags update the customer-site basket immediately.
          </p>
          <p className="mt-1 text-xs text-white/40">Every imported DB Cinema listing appears here automatically. Tagging never changes physical stock quantities.</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-right">
          <span className="block text-2xl font-semibold text-amber-200">{results.filter((item) => item.marketingOnly).length}</span>
          <span className="text-[11px] text-white/45">tagged on this page</span>
        </div>
      </header>

      <div className="sticky top-16 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#141518]/95 p-3 backdrop-blur">
        <input
          aria-label="Search imported listings"
          placeholder="Search any imported listing…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-amber-300/60"
        />
        <div role="group" aria-label="Filter listings" className="flex flex-wrap gap-2">
          {([["all", "All"], ["marketing", "Marketing only"], ["other", "Not tagged"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-lg px-3 py-2 text-xs transition ${filter === value ? "bg-amber-200 text-[#161412]" : "border border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.08]"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          data-testid="save-marketing-listing-tags"
          type="button"
          disabled={!dirty || busy}
          onClick={save}
          className="rounded-lg bg-amber-200 px-4 py-2 text-sm font-semibold text-[#161412] transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Saving and syncing…" : dirty ? `Save ${dirty} ${dirty === 1 ? "change" : "changes"}` : "Save changes"}
        </button>
        {dirty > 0 && <button type="button" disabled={busy} onClick={() => { setDrafts({}); setError(""); }} className="text-xs text-white/55 underline">Discard</button>}
      </div>

      {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-sm text-rose-200">{error}</p>}
      {status === "LoadingFirstPage" && <p className="py-8 text-center text-sm text-white/45">Loading imported listings…</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((item) => {
          const draft = drafts[String(item.productId)];
          const selected = draft?.marketingOnly ?? item.marketingOnly;
          return (
            <button
              key={item.productId}
              type="button"
              data-marketing-listing={item.productId}
              aria-pressed={selected}
              aria-label={`${item.name}. ${selected ? "Marketing only" : "Not marketing only"}. Click to ${selected ? "remove tag" : "mark marketing only"}.`}
              onClick={() => toggle(item.productId, item.marketingOnly, item.updatedAt)}
              className={`group flex min-h-40 min-w-0 flex-col rounded-xl border p-4 text-left transition ${selected ? "border-amber-300/55 bg-amber-300/[0.07] hover:bg-amber-300/[0.11]" : "border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]"}`}
            >
              <div className="flex w-full items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-medium leading-5 text-white/90">{item.name}</h3>
                  <p className="mt-2 text-[11px] text-white/45">Listing {item.productId} · {item.isPublished ? "Published" : "Not published"}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${selected ? "bg-amber-300/15 text-amber-200" : "bg-white/[0.06] text-white/45"}`}>
                  {selected ? "Marketing only" : "Bookable tag off"}
                </span>
              </div>
              <div className="mt-auto flex w-full items-end justify-between gap-3 pt-6">
                <span className="text-xs text-white/45">
                  {item.source === "manual" ? "Manual tag" : "Automatic catalogue match"}
                  {item.matchScore !== null ? ` · ${Math.round(item.matchScore * 100)}% match` : ""}
                </span>
                <span className={`rounded-full border px-3 py-1.5 text-xs ${selected ? "border-amber-200/60 text-amber-100" : "border-white/15 text-white/60 group-hover:border-white/30"}`}>
                  {selected ? "Click to untag" : "Click to tag"}
                </span>
              </div>
            </button>
          );
        })}
        {status !== "LoadingFirstPage" && !visible.length && <p className="col-span-full py-8 text-center text-sm text-white/45">No listings match this search and filter.</p>}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-3">
        <p className="text-xs text-white/40">Showing {results.length} imported listing{results.length === 1 ? "" : "s"} so far. New imports appear automatically.</p>
        {status === "CanLoadMore" && <button type="button" onClick={() => loadMore(24)} className="rounded-lg border border-white/15 px-4 py-2 text-xs text-white/70 hover:border-amber-200/60 hover:text-amber-100">Show more listings</button>}
        {status === "LoadingMore" && <span className="text-xs text-white/45">Loading more…</span>}
      </footer>
    </section>
  );
}
