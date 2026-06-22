"use client";
import { useMutation } from "convex/react";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

export function PriceRecommendations() {
  const { activeAccountSlug } = useAccount();
  const [applying, setApplying] = useState<Set<string>>(new Set());
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const data = useStableQuery(api.items.getPriceRecommendations, {
    accountSlug: activeAccountSlug,
  });
  // No-arg query: pass undefined so we don't churn a fresh `{}` reference
  // every render (audit 2026-05-23: cuts unnecessary Convex serialization).
  const dismissedNames = useStableQuery(api.pricing_catalog.getDismissedItemNames);

  const applyMutation = useMutation(api.pricing_catalog.applyRecommendation);
  const dismissMutation = useMutation(api.pricing_catalog.dismissRecommendation);

  const dismissedSet = new Set(dismissedNames ?? []);
  const visible = data
    ? data.filter(
        (r) => r !== null && !dismissedSet.has(r!.name)
      )
    : [];

  async function handleApply(name: string, suggestedRate: number) {
    setApplying((p) => new Set([...p, name]));
    setLocalErrors((p) => ({ ...p, [name]: "" }));
    try {
      await applyMutation({ itemNameCanonical: name, newDailyRate: suggestedRate });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalErrors((p) => ({ ...p, [name]: msg }));
    } finally {
      setApplying((p) => {
        const next = new Set(p);
        next.delete(name);
        return next;
      });
    }
  }

  async function handleDismiss(name: string) {
    setDismissing((p) => new Set([...p, name]));
    try {
      await dismissMutation({ itemNameCanonical: name });
    } finally {
      setDismissing((p) => {
        const next = new Set(p);
        next.delete(name);
        return next;
      });
    }
  }

  return (
    <Card>
      <CardHeader
        title="Price Recommendations"
        badge={
          visible.length > 0 ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}
            >
              {visible.length}
            </span>
          ) : null
        }
      />

      {(data === undefined || dismissedNames === undefined) && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <SkeletonBlock key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}

      {data !== undefined &&
        dismissedNames !== undefined &&
        visible.length === 0 && (
          <EmptyState message="All pricing looks good" icon="✓" />
        )}

      {data !== undefined && dismissedNames !== undefined && visible.length > 0 && (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {visible.map((item) => {
            const raise = item!.pctChange > 0;
            const changeColor = raise ? "#22c55e" : "#ef4444";
            const changeBg = raise
              ? "rgba(34,197,94,0.12)"
              : "rgba(239,68,68,0.12)";
            const isApplying = applying.has(item!.name);
            const isDismissing = dismissing.has(item!.name);
            const err = localErrors[item!.name];
            return (
              <div
                key={String(item!.itemId)}
                className="px-3 py-2.5 rounded-lg"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-medium truncate"
                      style={{ color: "#e4e6eb" }}
                    >
                      {item!.name}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "#8b8fa3" }}>
                      {item!.demandSignal}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-xs" style={{ color: "#8b8fa3" }}>
                        £{item!.currentRate}/d
                      </p>
                      <p
                        className="text-sm font-semibold"
                        style={{ color: changeColor }}
                      >
                        £{item!.suggestedRate}/d
                      </p>
                    </div>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded font-semibold"
                      style={{ color: changeColor, background: changeBg }}
                    >
                      {raise ? "+" : ""}
                      {item!.pctChange}%
                    </span>
                  </div>
                </div>
                {err && (
                  <p className="text-xs mt-1" style={{ color: "#ef4444" }}>
                    {err}
                  </p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    className="text-xs px-3 py-1 rounded font-medium transition-colors disabled:opacity-50"
                    style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
                    disabled={isApplying || isDismissing}
                    onClick={() => handleApply(item!.name, item!.suggestedRate)}
                  >
                    {isApplying ? "Applying…" : "Apply"}
                  </button>
                  <button
                    className="text-xs px-3 py-1 rounded transition-colors disabled:opacity-50"
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      color: "#8b8fa3",
                    }}
                    disabled={isApplying || isDismissing}
                    onClick={() => handleDismiss(item!.name)}
                  >
                    {isDismissing ? "Dismissing…" : "Dismiss"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
