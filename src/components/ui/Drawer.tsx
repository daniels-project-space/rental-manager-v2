"use client";
import { useEffect, useRef } from "react";

interface DrawerProps {
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}

export function Drawer({ onClose, children, title }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div
      className="drawer-backdrop fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        className="drawer-panel h-full overflow-y-auto flex flex-col"
        style={{
          width: "min(400px, 100vw)",
          background: "rgba(10,12,20,0.99)",
          borderLeft: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
        >
          {title && (
            <span className="text-sm font-semibold text-[#e4e6eb]">{title}</span>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
