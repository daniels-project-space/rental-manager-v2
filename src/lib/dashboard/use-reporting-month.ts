"use client";
import { useEffect, useState } from "react";

/** Revenue reporting retains the backend's UTC month boundary. */
export function useReportingMonth() {
  const current = () => new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(current);
  useEffect(() => {
    const refresh = () => setMonth(current());
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", refresh); };
  }, []);
  return month;
}
