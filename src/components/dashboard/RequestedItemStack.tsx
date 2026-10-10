"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./RequestedItemStack.module.css";
export type StackItem = {
  name: string;
  display_name?: string;
  qty: number;
  image_url: string | null;
  origin?: "basket" | "chat";
};
export function RequestedItemStack({
  items,
  size = 38,
}: {
  items: StackItem[];
  size?: number;
}) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false),
    [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 400 });
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        setPinned(false);
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest("[data-requested-stack]")) {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener("keydown", close, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", close, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  const show = (element: HTMLElement) => {
    const r = element.getBoundingClientRect(),
      width = Math.min(340, innerWidth - 16),
      height = Math.min(430, innerHeight - 24);
    const top = Math.max(8, Math.min(innerHeight - height - 8, r.bottom + 8));
    setPosition({
      left: Math.max(8, Math.min(innerWidth - width - 8, r.left)),
      top,
      maxHeight: height,
    });
    setOpen(true);
  };
  if (!items.length) return <span className={styles.empty}>◇</span>;
  return (
    <>
      <button
        data-requested-stack
        type="button"
        className={styles.stack}
        style={{
          width: size + Math.min(items.length - 1, 2) * 7,
          height: size + Math.min(items.length - 1, 2) * 4,
        }}
        aria-label={`Show all ${items.length} requested items`}
        aria-expanded={open}
        onMouseEnter={(event) => {
          if (!matchMedia("(hover: none)").matches) show(event.currentTarget);
        }}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible"))
            show(event.currentTarget);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            show(event.currentTarget);
          }
        }}
      >
        {items
          .slice(0, 3)
          .reverse()
          .map((item, reverse) => {
            const index = Math.min(items.length, 3) - 1 - reverse;
            return (
              <span
                key={index}
                className={styles.layer}
                style={{
                  width: size,
                  height: size,
                  left: index * 7,
                  top: index * 4,
                  zIndex: 3 - index,
                }}
              >
                {item.image_url ? (
                  <img
                    data-no-zoom
                    src={item.image_url}
                    alt={item.display_name ?? item.name}
                  />
                ) : (
                  <span>◇</span>
                )}
              </span>
            );
          })}
        {items.length > 1 && <b className={styles.count}>{items.length}</b>}
      </button>
      {open &&
        createPortal(
          <section
            data-requested-stack
            className={styles.popover}
            style={{
              left: position.left,
              top: position.top,
              maxHeight: position.maxHeight,
            }}
            aria-label="All requested items"
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => {
              if (!pinned) setOpen(false);
            }}
          >
            <header>
              <strong>Requested equipment</strong>
              <button
                type="button"
                aria-label="Close requested items"
                onClick={() => {
                  setOpen(false);
                  setPinned(false);
                }}
              >
                ×
              </button>
            </header>
            <div>
              {items.map((item, index) => (
                <article key={`${index}-${item.name}`}>
                  {item.image_url ? (
                    <img
                      data-no-zoom
                      src={item.image_url}
                      alt={item.display_name ?? item.name}
                    />
                  ) : (
                    <span className={styles.missing}>◇</span>
                  )}
                  <div>
                    <strong>{item.display_name ?? item.name}</strong>
                    <small>
                      {item.qty}× ·{" "}
                      {item.origin === "chat"
                        ? "Mentioned in chat"
                        : "In basket"}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </section>,
          document.body,
        )}
    </>
  );
}
