"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Pack cards by their measured content height, including expanded drawers. */
export function StatPackingGrid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const row = 8, gap = 10;
    const measure = (element: Element) => {
      const widget = element as HTMLElement;
      widget.style.gridRowEnd = `span ${Math.max(1, Math.ceil((widget.getBoundingClientRect().height + gap) / (row + gap)))}`;
    };
    const resize = new ResizeObserver((entries) => entries.forEach(({ target }) => measure(target)));
    const observe = () => {
      resize.disconnect();
      Array.from(grid.children).forEach((widget) => { measure(widget); resize.observe(widget); });
    };
    observe();
    const mutation = new MutationObserver(observe);
    mutation.observe(grid, { childList: true });
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, []);
  return <div ref={ref} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 grid-flow-dense gap-2.5 mt-2 items-start" style={{ gridAutoRows: 8 }}>{children}</div>;
}
