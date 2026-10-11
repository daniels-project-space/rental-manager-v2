"use client";
import { useId, useState, type ReactNode } from "react";

type Utility = { id: string; label: string; mobileLabel?: string; summary?: ReactNode; content: ReactNode };
export function UtilityBar({ items, renderButton }: {
  items: Utility[];
  renderButton?: (id: string, button: ReactNode) => ReactNode;
}) {
  const prefix = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  const reveal = (id: string) => {
    setOpen(id);
    setVisited((ids) => ids.includes(id) ? ids : [...ids, id]);
  };
  if (!items.length) return null;
  return (
    <section data-utility-bar aria-label="Dashboard tools" className="mb-3 rounded-xl border border-white/10 bg-slate-950/40 p-1.5"
      onMouseLeave={(e) => { if (!e.currentTarget.contains(document.activeElement)) setOpen(null); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(null); }}
      onKeyDown={(e) => { if (e.key === "Escape") { setOpen(null); e.stopPropagation(); } }}>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item) => {
          const button = <button type="button" aria-expanded={open === item.id} aria-controls={`${prefix}-${item.id}`}
            onPointerEnter={(e) => { if (e.pointerType === "mouse") reveal(item.id); }}
            onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) reveal(item.id); }}
            onClick={() => open === item.id ? setOpen(null) : reveal(item.id)}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 sm:px-3 py-1.5 text-xs text-slate-300 hover:border-blue-400/40 hover:bg-blue-500/10 focus-visible:outline-2 focus-visible:outline-blue-400">
            {item.mobileLabel ? <><span className="hidden sm:inline">{item.label}</span><span className="sm:hidden">{item.mobileLabel}</span></> : item.label}{item.summary !== undefined && <span className="text-blue-300">{item.summary}</span>}<span aria-hidden="true" className="text-slate-500">{open === item.id ? "▴" : "▾"}</span>
          </button>;
          return <div key={item.id}>{renderButton ? renderButton(item.id, button) : button}</div>;
        })}
      </div>
      {items.map((item) => visited.includes(item.id) && <div key={item.id} id={`${prefix}-${item.id}`} hidden={open !== item.id} className="mt-2 max-h-[65dvh] overflow-auto rounded-lg border border-white/10 bg-slate-950/80 p-3">
        <div className="mb-2 flex justify-end"><button type="button" aria-label={`Close ${item.label}`} onClick={() => setOpen(null)} className="rounded-full px-2 py-1 text-xs text-slate-400 hover:text-white">Close ×</button></div>
        {item.content}
      </div>)}
    </section>
  );
}
