"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useCountUp } from "@/hooks/useCountUp";

const gbp = (n: number) => `£${Math.round(n).toLocaleString()}`;

function Metric({
  label,
  value,
  color = "#e4e6eb",
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div
      className="p-3 rounded-xl flex flex-col gap-0.5 row-hover"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <span className="text-xs uppercase tracking-wider" style={{ color: "#8b8fa3" }}>
        {label}
      </span>
      <span className="text-xl font-bold" style={{ color }}>
        {value}
      </span>
      {sub && (
        <span className="text-xs" style={{ color: "#8b8fa3" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function HeroResell({ value }: { value: number }) {
  const animated = useCountUp(value, 700);
  return (
    <p className="text-4xl font-bold" style={{ color: "#22c55e" }}>
      {gbp(animated)}
    </p>
  );
}

export function EquipmentValuePanel() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.items.getEquipmentValue, {
    accountSlug: activeAccountSlug,
  });

  return (
    <Card>
      <CardHeader title="Equipment Value & Resell" />

      {data === undefined && (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(6)].map((_, i) => (
            <SkeletonBlock key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      )}

      {data !== undefined && (
        <div className="space-y-4">
          {/* Hero: current resell value with depreciation badge */}
          <div
            className="p-4 rounded-xl text-center"
            style={{ background: "rgba(34,197,94,0.08)" }}
          >
            <p
              className="text-xs uppercase tracking-wider mb-1"
              style={{ color: "#8b8fa3" }}
            >
              Estimated Resell Value (now)
            </p>
            <HeroResell value={data.total.resell_gbp} />
            <p className="text-xs mt-1" style={{ color: "#8b8fa3" }}>
              {data.retained_pct}% of cost retained ·{" "}
              {data.monthly_depreciation_pct}%/mo declining balance ·{" "}
              {Math.round(data.months_elapsed)} mo old
            </p>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="Acquisition Cost"
              value={gbp(data.total.acquisition_gbp)}
              color="#6ea8fe"
              sub="what it cost (qty-aware)"
            />
            <Metric
              label="Resell Value"
              value={gbp(data.total.resell_gbp)}
              color="#22c55e"
              sub="depreciated to today"
            />
            <Metric
              label="Depreciation"
              value={`−${gbp(data.total.depreciation_gbp)}`}
              color="#ef4444"
              sub="cost − resell"
            />
            <Metric
              label="Units / SKUs"
              value={`${data.total.units} / ${data.total.sku_count}`}
              color="#a78bfa"
              sub="owned items"
            />
          </div>

          {/* By category */}
          {data.by_category.length > 0 && (
            <div className="space-y-1.5">
              <p
                className="text-xs uppercase tracking-wider"
                style={{ color: "#8b8fa3" }}
              >
                By category
              </p>
              {data.by_category.slice(0, 6).map((c) => (
                <div
                  key={c.kind}
                  className="flex items-center justify-between text-sm px-3 py-1.5 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <span style={{ color: "#e4e6eb" }} className="capitalize">
                    {c.kind.replace(/_/g, " ")}
                    <span style={{ color: "#8b8fa3" }} className="ml-1.5 text-xs">
                      ×{c.units}
                    </span>
                  </span>
                  <span style={{ color: "#8b8fa3" }}>
                    {gbp(c.acquisition_gbp)} →{" "}
                    <span style={{ color: "#22c55e" }}>{gbp(c.resell_gbp)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Top items by value */}
          {data.items.length > 0 && (
            <div className="space-y-1.5">
              <p
                className="text-xs uppercase tracking-wider"
                style={{ color: "#8b8fa3" }}
              >
                Top items by value
              </p>
              {data.items.slice(0, 6).map((it) => (
                <div
                  key={it.name}
                  className="flex items-center justify-between text-sm px-3 py-1.5 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <span style={{ color: "#e4e6eb" }}>
                    {it.name}
                    {it.units > 1 && (
                      <span style={{ color: "#8b8fa3" }} className="ml-1.5 text-xs">
                        ×{it.units}
                      </span>
                    )}
                  </span>
                  <span style={{ color: "#8b8fa3" }}>
                    {gbp(it.acquisition_total)} →{" "}
                    <span style={{ color: "#22c55e" }}>{gbp(it.resell_total)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
