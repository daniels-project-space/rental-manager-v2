"use client";
import type { ReactNode } from "react";

/** Native rows reserve content height from the first paint, including drawers. */
export function StatPackingGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 grid-flow-dense auto-rows-auto gap-2.5 mt-2 items-start">
      {children}
    </div>
  );
}
