"use client";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

type Severity = "error" | "warning";

const SEVERITY_STYLES: Record<Severity, { color: string; bg: string; label: string }> = {
  error: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", label: "Error" },
  warning: { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "Warning" },
};

const ISSUE_ICONS: Record<string, string> = {
  missing_pricing: "£",
  missing_photo: "□",
  missing_renter: "?",
  missing_end_date: "!",
};

export function HealthScanner() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.health.getHealthReport, {
    accountSlug: activeAccountSlug,
  });

  const errorCount = data?.issues.filter((i) => i.severity === "error").length ?? 0;
  const warnCount = data?.issues.filter((i) => i.severity === "warning").length ?? 0;

  return (
    <Card>
      <CardHeader
        title="Health & Scanner"
        badge={
          data ? (
            <div className="flex gap-1">
              {errorCount > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
                >
                  {errorCount} error{errorCount !== 1 ? "s" : ""}
                </span>
              )}
              {warnCount > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
                >
                  {warnCount} warn
                </span>
              )}
              {errorCount === 0 && warnCount === 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
                >
                  Healthy
                </span>
              )}
            </div>
          ) : null
        }
      />

      {data === undefined && (
        <div className="space-y-3">
          <SkeletonBlock className="h-12 w-full rounded-lg" />
          <SkeletonBlock className="h-px w-full" />
          {[...Array(3)].map((_, i) => (
            <SkeletonBlock key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      )}

      {data !== undefined && (
        <>
          {/* Sync status section */}
          <div
            className="flex items-center justify-between px-3 py-2.5 rounded-lg mb-4"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            <div>
              <p className="text-xs font-medium" style={{ color: "#e4e6eb" }}>Hygglo Sync</p>
              <p className="text-xs" style={{ color: "#8b8fa3" }}>
                {data.readOnlyMode ? "Read-only mode active" : "Live writes enabled"}
              </p>
            </div>
            <span
              className="text-xs px-2 py-1 rounded-full font-semibold"
              style={
                data.syncStatus === "live"
                  ? { background: "rgba(34,197,94,0.15)", color: "#22c55e" }
                  : { background: "rgba(245,158,11,0.15)", color: "#f59e0b" }
              }
            >
              {data.syncStatus === "live" ? "Live" : "Read-only"}
            </span>
          </div>

          {/* Issue list */}
          {data.issues.length === 0 ? (
            <EmptyState message="No data quality issues found" icon="✓" />
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {data.issues.map((issue, i) => {
                const style = SEVERITY_STYLES[issue.severity];
                return (
                  <div
                    key={i}
                    className="flex items-start gap-3 px-2.5 py-2 rounded-lg"
                    style={{ background: style.bg, border: `1px solid ${style.color}22` }}
                  >
                    <span
                      className="text-xs font-bold w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: `${style.color}22`, color: style.color }}
                    >
                      {ISSUE_ICONS[issue.type] ?? "!"}
                    </span>
                    <div className="min-w-0">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded font-medium mr-1.5"
                        style={{ background: style.bg, color: style.color }}
                      >
                        {style.label}
                      </span>
                      <span className="text-xs" style={{ color: "#e4e6eb" }}>
                        {issue.description}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
