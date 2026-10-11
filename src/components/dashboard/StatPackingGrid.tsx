"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";

const PACKING_ROW_PX = 4;

/** Dense placement with independent heights, measured from natural content. */
export function AutoPackingGrid({ children, className = "" }: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const slots = Array.from(grid.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const items = slots.flatMap((slot) => {
      const content = slot.querySelector<HTMLElement>(":scope > [data-packing-content]");
      return content ? [{ slot, content }] : [];
    });
    if (!items.length || items.length !== grid.children.length) {
      grid.style.gridAutoRows = "auto";
      grid.style.rowGap = "";
      delete grid.dataset.packing;
      for (const slot of slots) slot.style.gridRow = "";
      return;
    }
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 10;
      // Read natural heights before writing grid spans. offsetHeight ignores drag transforms.
      const updates = items.map(({ slot, content }) => ({
        slot,
        rows: Math.max(1, Math.ceil((content.offsetHeight + 1 + gap) / PACKING_ROW_PX)),
      }));
      for (const { slot, rows } of updates) {
        // Reset both lines: a legacy row-start span would override row-end alone.
        const row = `auto / span ${rows}`;
        if (slot.style.gridRow !== row) slot.style.gridRow = row;
      }
      grid.style.gridAutoRows = `${PACKING_ROW_PX}px`;
      grid.style.rowGap = "0px";
      grid.dataset.packing = "masonry";
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const { content } of items) observer.observe(content);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div ref={ref} data-auto-packing-grid className={`grid grid-flow-dense items-start ${className}`}>
      {children}
    </div>
  );
}

export function StatPackingGrid({ children }: { children: ReactNode }) {
  return (
    <AutoPackingGrid className="grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2.5 mt-2">
      {children}
    </AutoPackingGrid>
  );
}
