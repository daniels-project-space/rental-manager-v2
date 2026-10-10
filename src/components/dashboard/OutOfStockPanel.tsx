"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useStockForecast } from "@/lib/dashboard/use-stock-forecast";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function formatMoment(at:number){
  return new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(at));
}

export function OutOfStockPanel() {
  const { activeAccountSlug } = useAccount();

  const rows = useStableQuery(api.items.getOutOfStockItems, {
    accountSlug: activeAccountSlug,
    lookAheadDays: 14,
  });
  const data = useStockForecast(rows);

  return (
    <Card>
      <CardHeader
        title="Stock outlook · 14 days"
        badge={
          data ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
            >
              {data.length}
            </span>
          ) : null
        }
      />

      {data === undefined && (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <SkeletonBlock key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState message="No fully booked periods in this outlook" icon="✓" />
      )}

      {data !== undefined && data.length > 0 && (
        <div className="space-y-2">
          {data.map((item) => {
            return (
              <div
                key={item.itemId as string}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)" }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.image}
                      alt=""
                      loading="lazy"
                      className="w-9 h-9 rounded-md object-cover flex-shrink-0 ring-1 ring-white/10"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 text-sm" style={{ background: "rgba(239,68,68,0.12)", color: "#f87171" }}>
                      📷
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "#e4e6eb" }}>
                      {item.name}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "#8b8fa3" }}>
                      {item.activeReservationCount} of {item.ownedUnits} units committed{item.inRepair ? ` · ${item.inRepair} in repair` : ""}
                    </p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-3">
                  <p className="text-xs font-medium" style={{color:item.currentlyUnavailable?"#f87171":"#f59e0b"}}>
                    {item.currentlyUnavailable?"Unavailable now":`Fully booked from ${formatMoment(item.blockedFromAt)}`}
                  </p>
                  <p className="text-xs mt-0.5" style={{color:"#8b8fa3"}}>
                    {item.nextAvailableAt===null?"Availability pending repair return":`Available again ${formatMoment(item.nextAvailableAt)}`}
                  </p>
                  <p className="text-[10px] mt-0.5" style={{color:"#6f727c"}}>London time · turnaround included</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
