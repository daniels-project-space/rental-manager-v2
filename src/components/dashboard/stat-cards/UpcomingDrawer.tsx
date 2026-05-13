"use client";

import { RentalRow } from "./ActiveDrawer";

interface UpcomingRental {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string | null;
  end_date: string | null;
  pickup_date?: string | null;
  pickup_time?: string | null;
  return_time?: string | null;
  items: string[];
  photo_url?: string | null;
  duration_days?: number | null;
  net_gbp?: number | null;
  days_until: number | null;
}

interface Props {
  data: {
    count: number;
    rentals: UpcomingRental[];
  };
}

export default function UpcomingDrawer({ data }: Props) {
  if (data.rentals.length === 0) {
    return <div className="text-xs text-slate-500 italic py-4 text-center">No upcoming pickups.</div>;
  }
  return (
    <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
      <div className="text-[11px] font-bold tracking-wider uppercase text-violet-400">
        UPCOMING ({data.count})
      </div>
      {data.rentals.map((r) => (
        <RentalRow key={r.reservation_id} r={{ ...r, kind: "upcoming", is_ongoing: false }} />
      ))}
    </div>
  );
}
