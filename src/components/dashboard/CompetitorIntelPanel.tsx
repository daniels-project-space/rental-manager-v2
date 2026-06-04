"use client";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Card } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Competitor Intel — collapsible TOP dashboard widget.
//
// Shows a PII-SAFE summary of a LIMITED sample (100 reviews/vendor) of two
// competitor vendors' public rental history: total estimated competitor
// revenue (take-home after ~36% platform fees), total rentals sampled, and an
// expandable top-rented-items list. Reads `competitor_intel:getTopItems`.
//
// est. revenue = rentalCount × dailyPrice × OWNER_SHARE (0.64) — "1 review ≈ 1
// day rental at current list price; rough estimate." Items with no matched
// price contribute £0. Default COLLAPSED.
export function CompetitorIntelPanel() {
  const [open, setOpen] = useState(false);
  const data = useQuery(api.competitor_intel.getTopItems, { limit: 25 });

  const loading = data === undefined;
  const totalRev = data?.totalEstRevenueGbp ?? 0;
  const totalRentals = data?.totalRentalsSampled ?? 0;
  const vendorsCount = data?.vendorsCount ?? 0;
  const items = data?.items ?? [];
  const maxRev =
    items.length > 0 ? Math.max(...items.map((i) => i.estRevenueGbp), 1) : 1;

  return (
    <Card>
      {/* Clickable header — toggles the items list. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[#e4e6eb]">
              Competitor Intel
            </span>
            <span
              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded"
              style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}
            >
              {vendorsCount > 0 ? `${vendorsCount} vendors` : "sample"}
            </span>
          </div>
          <div className="text-xs text-[#8b8fa3] mt-0.5">
            based on 100 reviews/vendor · est. take-home after ~36% fees
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {loading ? (
            <SkeletonBlock className="h-8 w-28" />
          ) : (
            <div className="text-right">
              <div
                className="text-base font-semibold leading-tight"
                style={{ color: "#22c55e" }}
              >
                £{totalRev.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
              </div>
              <div className="text-xs text-[#8b8fa3] leading-tight">
                {totalRentals} rentals sampled
              </div>
            </div>
          )}
          <span
            className="text-[#8b8fa3] transition-transform duration-200"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-hidden
          >
            ▶
          </span>
        </div>
      </button>

      {/* Expandable top-rented-items list. */}
      {open && (
        <div className="mt-4 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <SkeletonBlock key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-xs text-[#8b8fa3] py-2">
              No competitor sample yet — run scripts/ingest-competitor-intel.mjs.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-[#8b8fa3] mb-1">
                Top rented items
              </div>
              {items.map((item, i) => {
                const barPct = Math.max(2, (item.estRevenueGbp / maxRev) * 100);
                return (
                  <div key={item.itemName} className="flex items-center gap-2">
                    <span className="w-5 text-xs text-[#8b8fa3] text-right flex-shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between mb-0.5">
                        <span className="text-sm text-[#e4e6eb] truncate">
                          {item.itemName}
                        </span>
                        <span
                          className="text-sm font-semibold flex-shrink-0 ml-2"
                          style={{ color: "#22c55e" }}
                        >
                          £{item.estRevenueGbp.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      <div
                        className="h-1.5 w-full rounded-full overflow-hidden"
                        style={{ background: "rgba(255,255,255,0.05)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${barPct}%`, background: "#6ea8fe" }}
                        />
                      </div>
                      <div className="text-xs text-[#8b8fa3] mt-0.5">
                        {item.rentalCount} rentals
                        {typeof item.dailyPriceGbp === "number"
                          ? ` · £${item.dailyPriceGbp.toFixed(0)}/day`
                          : " · no list price"}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="text-[11px] text-[#6b6f80] pt-1">
                est. £ = rentals × daily price × 0.64 take-home · rough estimate
                (1 review ≈ 1 day rental at current list price)
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
