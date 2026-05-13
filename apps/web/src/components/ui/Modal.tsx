"use client";
import { useEffect, useRef } from "react";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Width class, default "max-w-sm" */
  width?: string;
}

/**
 * Shared modal shell:
 * - Animated backdrop (fade-in 200ms) + card (slide-up 250ms spring)
 * - Click-outside closes, ESC closes, body scroll locked
 */
export function Modal({ onClose, children, width = "max-w-sm" }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={handleBackdropClick}
    >
      <div
        ref={cardRef}
        className={`modal-card w-full ${width} p-5 rounded-xl`}
        style={{
          background: "rgba(14,17,28,0.98)",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
