"use client";
import CalendarGantt from "./CalendarGantt";
import { useAccount } from "@/lib/account-context";
export function LiveCalendar() {
  const { activeAccountSlug } = useAccount();
  return <CalendarGantt open embedded onClose={() => {}} accountSlug={activeAccountSlug ?? undefined} />;
}
