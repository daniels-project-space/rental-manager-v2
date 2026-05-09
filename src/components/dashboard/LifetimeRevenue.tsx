"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function fmt(n: number) {
  if (n >= 1000) return `£${(n / 1000).toFixed(1)}k`;
  return `£${n.toFixed(2)}`;
}

export function LifetimeRevenue() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.dashboard.getLifetimeSummary, {
    accountSlug: activeAccountSlug,
  });

  return (
    <Card className="relative overflow-hidden">
      {/* green gradient wash */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top left, rgba(34,197,94,0.08) 0%, transparent 60%)",
        }}
      />
      <CardHeader title="Total Lifetime Revenue" />

      {data === undefined ? (
        <div className="space-y-3">
          <SkeletonBlock className="h-14 w-48" />
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <SkeletonBlock key={i} className="h-12" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div
            className="text-5xl font-bold leading-none mb-1"
            style={{ color: "#22c55e" }}
          >
            {fmt(data.totalRevenue)}
          </div>
          <p className="text-xs text-[#8b8fa3] mb-5">All-time gross revenue</p>

          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-xl font-bold text-[#e4e6eb]">
                {data.totalBookings}
              </div>
              <div className="text-xs text-[#8b8fa3] uppercase tracking-wider mt-0.5">
                Bookings
              </div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-[#e4e6eb]">
                {fmt(data.avgValue)}
              </div>
              <div className="text-xs text-[#8b8fa3] uppercase tracking-wider mt-0.5">
                Avg Value
              </div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-[#e4e6eb]">
                {data.totalDays}
              </div>
              <div className="text-xs text-[#8b8fa3] uppercase tracking-wider mt-0.5">
                Total Days
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
