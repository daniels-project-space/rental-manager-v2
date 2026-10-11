"use client";

import { useMemo, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { createBundleMappingContext } from "../../../convex/lib/bundle_mapping";
import { resolveListingComponents, type ListingResolverItem } from "../../../convex/lib/listing_components";
import { listingMappingReviewStatus, type ListingMappingReviewStatus } from "../../../convex/lib/listing_mapping_review";

type MappingInventoryItem = {
  id: Id<"items">;
  name: string;
  displayName: string;
  kind: string;
  qty: number;
  aliases: string[];
};
type ReviewComponent = { item_id: string; qty: number };
type ListingReviewRow = {
  productId: number;
  name: string;
  isPublished: boolean;
  isMarketingOnly: boolean;
  masterItemId: string | null;
  primaryItem: { id: string; name: string; status: string; qty: number; marketingOnly: boolean } | null;
  description: string;
  resolutionDescription: string;
  descriptionTruncated: boolean;
  override: { components: ReviewComponent[]; note: string | null } | null;
  revision: string | null;
  mappingConflict: boolean;
};

type ClassifiedListingReviewRow = ListingReviewRow & { mappingStatus: ListingMappingReviewStatus; resolution: ReturnType<typeof resolveListingComponents> | null };
const EMPTY_RESOLVER_ITEMS: ListingResolverItem[] = [];

const filterOptions = [
  { key: "needs", label: "Needs review" },
  { key: "mapped", label: "Mapped" },
  { key: "no_stock", label: "No physical stock" },
  { key: "marketing", label: "Marketing only" },
  { key: "all", label: "All listings" },
] as const;
type ReviewFilter = (typeof filterOptions)[number]["key"];

function ListingMappingCard({
  listing,
  inventory,
}: {
  listing: ClassifiedListingReviewRow;
  inventory: MappingInventoryItem[];
}) {
  const saveOverride = useMutation(api.listing_overrides.setOverride);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  const [showAllItems, setShowAllItems] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>(() =>
    Object.fromEntries((listing.override?.components ?? []).map((component) => [component.item_id, component.qty])),
  );
  const inventoryById = useMemo(
    () => new Map(inventory.map((item) => [String(item.id), item])),
    [inventory],
  );
  const selectedRows = Object.entries(selected)
    .map(([id, qty]) => ({ id, qty, item: inventoryById.get(id) }))
    .sort((a, b) => (a.item?.name ?? a.id).localeCompare(b.item?.name ?? b.id));
  const search = itemSearch.trim().toLowerCase();
  const filteredItems = inventory.filter((item) => {
    if (!search) return true;
    return [item.name, item.displayName, item.kind, ...item.aliases]
      .some((value) => value.toLowerCase().includes(search));
  });
  const visibleItems = showAllItems || search ? filteredItems : filteredItems.slice(0, 12);
  const hasManualMap = !!listing.override;
  const canEdit = !listing.mappingConflict && !listing.isMarketingOnly && inventory.length > 0;

  function toggleItem(item: MappingInventoryItem) {
    setSelected((current) => {
      const next = { ...current };
      if (next[String(item.id)] !== undefined) delete next[String(item.id)];
      else next[String(item.id)] = 1;
      return next;
    });
    setSaved(false);
    setError("");
  }

  function changeQuantity(id: string, nextQty: number) {
    const item = inventoryById.get(id);
    if (!item) return;
    const qty = Math.max(1, Math.min(item.qty, Math.trunc(nextQty) || 1));
    setSelected((current) => ({ ...current, [id]: qty }));
    setSaved(false);
  }

  async function persist(components: Array<{ item_id: Id<"items">; qty: number }>, note: string) {
    if (!listing.revision || saving || !canEdit) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await saveOverride({
        account_slug: "dbcinema",
        product_id: listing.productId,
        components,
        note,
        expected_revision: listing.revision,
      });
      setSelected(Object.fromEntries(components.map((component) => [String(component.item_id), component.qty])));
      setSaved(true);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this mapping.");
    } finally {
      setSaving(false);
    }
  }

  function saveMapping() {
    const components = Object.entries(selected).map(([item_id, qty]) => ({
      item_id: item_id as Id<"items">,
      qty,
    }));
    if (components.length === 0) {
      setError("Choose owned stock, or use the separate no-stock action.");
      return;
    }
    return persist(components, "Owner-reviewed availability map");
  }

  function markNoPhysicalStock() {
    if (!window.confirm("Record that this listing uses no physical DB Cinema inventory? It will stay unavailable until a stock map is saved.")) return;
    return persist([], "Owner confirmed no physical stock for this listing");
  }

  return (
    <article className="rounded-2xl border border-white/[0.09] bg-[#0c1018] p-4 shadow-[0_12px_35px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-sm font-semibold text-[#eef0f5]">{listing.name}</h3>
            <span className="rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[10px] text-[#9ca3b1]">#{listing.productId}</span>
            {!listing.isPublished && <span className="rounded-full border border-white/[0.1] px-2 py-0.5 text-[10px] text-[#858c99]">Unpublished</span>}
            {listing.isMarketingOnly && <span className="rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-2 py-0.5 text-[10px] text-amber-200">Marketing only</span>}
          </div>
          <p className="mt-1 text-[11px] text-[#8d95a3]">
            {listing.primaryItem
              ? "Source link: " + listing.primaryItem.name + " · " + listing.primaryItem.qty + " in Rental Manager · " + listing.primaryItem.status + (listing.primaryItem.marketingOnly ? " · marketing only" : "")
              : listing.masterItemId
                ? "Source item is missing from the current inventory."
                : "No primary Rental Manager item is linked."}
          </p>
          {listing.mappingStatus === "needs_review" && listing.resolution && !listing.isMarketingOnly && (
            <section className="mt-3 rounded-xl border border-sky-400/15 bg-sky-400/[0.035] p-3" aria-label="Resolver evidence">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-100/75">Resolver evidence · not saved</div>
              {listing.resolution.components.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {listing.resolution.components.map((component) => (
                    <span key={component.item_id} className="rounded-lg border border-white/[0.08] bg-black/15 px-2 py-1 text-[10px] text-[#c6ced9]">
                      {component.name ?? "Unresolved inventory item"} × {component.units_per_listing}
                      {component.owned === false ? " · not rentable" : component.owned === null ? " · unverified" : " · owned"}
                    </span>
                  ))}
                </div>
              )}
              {((listing.resolution.coverage?.missing.length ?? 0) > 0 ||
                (listing.resolution.coverage?.unresolved.length ?? 0) > 0 ||
                listing.resolution.unresolved_default_adapters.length > 0) && (
                <ul className="mt-2 space-y-1 text-[10px] text-amber-100/80">
                  {listing.resolution.coverage?.missing.map((item) => <li key={`missing-${item.item_id}`}>Missing stock: {item.name} × {item.qty}</li>)}
                  {listing.resolution.coverage?.unresolved.map((line, index) => <li key={`contents-${index}`}>Unmatched contents: {line}</li>)}
                  {listing.resolution.unresolved_default_adapters.map((line, index) => <li key={`adapter-${index}`}>Unresolved supplied part: {line}</li>)}
                </ul>
              )}
              <p className="mt-2 text-[10px] text-[#8d95a3]">These are resolver findings, not a saved stock map. Review the description and choose only the physical items and counts you can verify.</p>
            </section>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:justify-end">
          {listing.mappingStatus === "verified" ? (
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200">Resolver confirms rentable stock</span>
          ) : listing.mappingStatus === "no_physical_stock" ? (
            <span className="rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-2.5 py-1 text-[10px] font-medium text-amber-200">Owner confirmed no physical stock</span>
          ) : listing.mappingStatus === "marketing_only" ? (
            <span className="rounded-full border border-white/[0.1] bg-white/[0.035] px-2.5 py-1 text-[10px] font-medium text-[#9aa3b0]">Marketing only</span>
          ) : listing.mappingStatus === "duplicate_maps" ? (
            <span className="rounded-full border border-red-400/25 bg-red-400/[0.08] px-2.5 py-1 text-[10px] font-medium text-red-200">Duplicate maps · admin review</span>
          ) : (
            <span className="rounded-full border border-sky-400/20 bg-sky-400/[0.07] px-2.5 py-1 text-[10px] font-medium text-sky-200">Resolver needs mapping review</span>
          )}
          {listing.override?.components.length ? <span className="text-[10px] text-[#7c8491]">Saved owner map</span> : null}
          {listing.isMarketingOnly && <span className="text-[10px] text-[#7c8491]">Demand logging stays enabled</span>}
        </div>
      </div>

      {listing.override?.components.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {listing.override.components.map((component) => {
            const item = inventoryById.get(component.item_id);
            return (
              <span key={component.item_id} className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 text-[11px] text-[#c4cad4]">
                {item?.name ?? "Inactive or missing item"} × {component.qty}
              </span>
            );
          })}
        </div>
      ) : null}

      {listing.description && (
        <details className="mt-3 rounded-xl border border-white/[0.07] bg-black/15 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-[#aab2c0]">Review listing description</summary>
          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-[#838c9a]">{listing.description}</p>
        </details>
      )}
      {listing.descriptionTruncated && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80">
          The stored listing description exceeds the resolver limit. It remains in Needs review and will not be marked as mapped automatically.
        </p>
      )}

      {saved && <p role="status" className="mt-3 text-xs text-emerald-300">Mapping saved and added to the inventory audit trail.</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}

      {!editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSelected(Object.fromEntries((listing.override?.components ?? []).map((component) => [component.item_id, component.qty])));
              setEditing(true);
              setError("");
            }}
            disabled={!canEdit}
            className="rounded-lg border border-[#bc805d]/45 bg-[#bc805d]/[0.12] px-3 py-2 text-xs font-semibold text-[#e7b596] transition hover:bg-[#bc805d]/[0.2] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {hasManualMap ? "Edit stock map" : "Review stock map"}
          </button>
          {listing.isMarketingOnly && <span className="text-[11px] text-[#7f8794]">Change the marketing-only tag in DB Cinema’s admin catalogue controls.</span>}
        </div>
      ) : (
        <div className="mt-4 space-y-3 border-t border-white/[0.08] pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[#e8ebf0]">Choose physical Rental Manager items</p>
              <p className="mt-1 text-[11px] text-[#858e9b]">Each selected tile adds stock to this listing. Counts cannot exceed recorded owned quantity.</p>
            </div>
            <label className="min-w-[220px] flex-1 sm:max-w-xs">
              <span className="sr-only">Search inventory items</span>
              <input
                value={itemSearch}
                onChange={(event) => { setItemSearch(event.target.value); setShowAllItems(false); }}
                placeholder="Search owned inventory…"
                className="w-full rounded-lg border border-white/[0.1] bg-black/20 px-3 py-2 text-xs text-[#e8ebf0] placeholder:text-[#687180] outline-none focus:border-[#bc805d]/65"
              />
            </label>
          </div>

          {selectedRows.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedRows.map(({ id, qty, item }) => (
                <div key={id} className="flex items-center gap-2 rounded-xl border border-[#bc805d]/30 bg-[#bc805d]/[0.08] px-2.5 py-2">
                  <span className="max-w-[220px] truncate text-[11px] text-[#e8c5af]">{item?.name ?? "Inactive item " + id}</span>
                  <button type="button" aria-label={"Decrease " + (item?.name ?? "quantity")} onClick={() => changeQuantity(id, qty - 1)} disabled={qty <= 1} className="h-6 w-6 rounded-md border border-white/[0.12] text-xs text-white disabled:opacity-30">−</button>
                  <span className="min-w-4 text-center text-xs text-white">{qty}</span>
                  <button type="button" aria-label={"Increase " + (item?.name ?? "quantity")} onClick={() => changeQuantity(id, qty + 1)} disabled={!item || qty >= item.qty} className="h-6 w-6 rounded-md border border-white/[0.12] text-xs text-white disabled:opacity-30">+</button>
                  <button type="button" aria-label={"Remove " + (item?.name ?? "item")} onClick={() => setSelected((current) => { const next = { ...current }; delete next[id]; return next; })} className="ml-1 text-xs text-[#9ba3b1] hover:text-red-200">Remove</button>
                </div>
              ))}
            </div>
          )}

          {inventory.length === 0 ? (
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs text-amber-100">No rentable active inventory is available to map.</p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {visibleItems.map((item) => {
                  const active = selected[String(item.id)] !== undefined;
                  return (
                    <div key={String(item.id)} className={"rounded-xl border p-2 transition " + (active ? "border-[#bc805d]/45 bg-[#bc805d]/[0.09]" : "border-white/[0.08] bg-white/[0.025]")}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleItem(item)}
                        className="flex min-h-14 w-full items-center justify-between gap-3 text-left"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium text-[#dbe0e8]">{item.displayName}</span>
                          <span className="mt-1 block truncate text-[10px] text-[#818b99]">{item.name} · {item.kind}</span>
                        </span>
                        <span className={"shrink-0 rounded-full px-2 py-1 text-[10px] " + (active ? "bg-[#bc805d]/20 text-[#f1c2a5]" : "bg-white/[0.06] text-[#a2a9b5]")}>
                          {item.qty} owned{active ? " · selected" : ""}
                        </span>
                      </button>
                      {active && (
                        <div className="mt-2 flex items-center justify-between border-t border-white/[0.07] pt-2">
                          <span className="text-[10px] text-[#8c95a3]">Units per listing</span>
                          <div className="flex items-center gap-2">
                            <button type="button" aria-label={"Decrease " + item.name} onClick={() => changeQuantity(String(item.id), (selected[String(item.id)] ?? 1) - 1)} disabled={(selected[String(item.id)] ?? 1) <= 1} className="h-6 w-6 rounded-md border border-white/[0.12] text-xs text-white disabled:opacity-30">−</button>
                            <span className="min-w-4 text-center text-xs text-white">{selected[String(item.id)]}</span>
                            <button type="button" aria-label={"Increase " + item.name} onClick={() => changeQuantity(String(item.id), (selected[String(item.id)] ?? 1) + 1)} disabled={(selected[String(item.id)] ?? 1) >= item.qty} className="h-6 w-6 rounded-md border border-white/[0.12] text-xs text-white disabled:opacity-30">+</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!search && filteredItems.length > 12 && (
                <button type="button" onClick={() => setShowAllItems((value) => !value)} className="text-[11px] text-[#d0a083] hover:text-[#efbd9d]">
                  {showAllItems ? "Show fewer inventory cards" : "Show all " + filteredItems.length + " inventory cards"}
                </button>
              )}
              {filteredItems.length === 0 && <p className="text-xs text-[#939ba8]">No active rentable item matches that search.</p>}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] pt-3">
            <button type="button" onClick={() => { setEditing(false); setError(""); }} disabled={saving} className="rounded-lg px-3 py-2 text-xs text-[#a7afbb] hover:bg-white/[0.06]">Cancel</button>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={markNoPhysicalStock}
                disabled={!canEdit || saving || (!!listing.override && listing.override.components.length === 0)}
                className="rounded-lg border border-white/[0.12] px-3 py-2 text-xs text-[#bdc4ce] hover:bg-white/[0.06] disabled:opacity-40"
              >
                Mark no physical stock
              </button>
              <button
                type="button"
                onClick={() => void saveMapping()}
                disabled={!canEdit || saving || selectedRows.length === 0}
                className="rounded-lg bg-[#bc805d] px-3 py-2 text-xs font-semibold text-[#15100d] hover:bg-[#d49a77] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save stock map"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

export function ListingMappingReview() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.listing_overrides.mappingReviewPage,
    { account_slug: "dbcinema" },
    { initialNumItems: 20 },
  );
  const inventoryData = useQuery(api.items.listForListingMapping, {});
  const inventory = inventoryData?.selectableItems;
  const resolverItems = inventoryData?.resolverItems ?? EMPTY_RESOLVER_ITEMS;
  const mappingContext = useMemo(() => createBundleMappingContext(resolverItems), [resolverItems]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>("needs");

  const classifiedRows = useMemo(() => (results as ListingReviewRow[]).map((listing): ClassifiedListingReviewRow => {
    const resolution = listing.mappingConflict || listing.descriptionTruncated ? null : resolveListingComponents(
      resolverItems,
      listing.override?.components.map((component) => ({ item_id: component.item_id, qty: component.qty })),
      listing.masterItemId ?? undefined,
      1,
      listing.resolutionDescription,
      mappingContext,
      listing.name,
    );
    return {
      ...listing,
      resolution,
      mappingStatus: listingMappingReviewStatus({
        isMarketingOnly: listing.isMarketingOnly,
        mappingConflict: listing.mappingConflict,
        hasOverride: !!listing.override,
        componentCount: listing.override?.components.length ?? 0,
        complete: resolution?.complete ?? false,
        owned: resolution?.owned ?? null,
      }),
    };
  }), [results, resolverItems, mappingContext]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return classifiedRows.filter((listing) => {
      const matchesSearch = !needle || listing.name.toLowerCase().includes(needle) || String(listing.productId).includes(needle);
      if (!matchesSearch) return false;
      if (filter === "marketing") return listing.isMarketingOnly;
      if (filter === "mapped") return listing.mappingStatus === "verified";
      if (filter === "no_stock") return listing.mappingStatus === "no_physical_stock";
      if (filter === "needs") return listing.mappingStatus === "needs_review" || listing.mappingStatus === "duplicate_maps";
      return true;
    });
  }, [classifiedRows, search, filter]);

  if (inventoryData === undefined || status === "LoadingFirstPage") {
    return <div className="rounded-2xl border border-white/[0.08] bg-[#0c1018] p-5 text-sm text-[#929aa7]">Loading Rental Manager inventory and listing maps…</div>;
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <label>
          <span className="sr-only">Search loaded listings by title or ID</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded listing titles or IDs…"
            className="w-full rounded-xl border border-white/[0.1] bg-black/20 px-3 py-2.5 text-xs text-[#e8ebf0] placeholder:text-[#687180] outline-none focus:border-[#bc805d]/65"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter listings">
          {filterOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              onClick={() => setFilter(option.key)}
              className={"rounded-lg border px-3 py-2 text-[11px] transition " + (filter === option.key ? "border-[#bc805d]/45 bg-[#bc805d]/[0.12] text-[#ecc3aa]" : "border-white/[0.08] bg-white/[0.025] text-[#9aa3b0] hover:bg-white/[0.06]")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#858e9b]">
        <span>Showing {rows.length} matching from {results.length} loaded listings. “Mapped” means the live resolver confirms rentable stock.</span>
        {status === "CanLoadMore" && (
          <button type="button" onClick={() => loadMore(20)} className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[#d7b09a] hover:bg-white/[0.06]">
            Load 20 more listings
          </button>
        )}
        {status === "LoadingMore" && <span>Loading more listings…</span>}
        {status === "Exhausted" && <span>All listings loaded.</span>}
      </div>

      {rows.length ? (
        <div className="space-y-3">
          {rows.map((listing) => (
            <ListingMappingCard key={listing.productId} listing={listing} inventory={inventory ?? []} />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.02] p-8 text-center text-xs text-[#87909e]">
          No listings match this filter in the loaded pages. Load more listings or change the filter.
        </div>
      )}
    </div>
  );
}
