"use client";
import { useState } from "react";
import styles from "./RequestedItemStack.module.css";
export type StackItem = {
  name: string;
  display_name?: string;
  qty: number;
  image_url: string | null;
  image_urls?: string[];
  origin?: "basket" | "chat";
};
function ItemImage({ item }: { item: StackItem }) {
  const sources = [
    ...new Set([item.image_url, ...(item.image_urls ?? [])].filter(Boolean)),
  ] as string[];
  const [failed, setFailed] = useState<string[]>([]);
  const src = sources.find((url) => !failed.includes(url));
  return src ? (
    <img
      data-no-zoom
      src={src}
      alt={item.display_name ?? item.name}
      onError={() => setFailed((old) => [...old, src])}
    />
  ) : (
    <span
      className={styles.missing}
      aria-label={`No image for ${item.display_name ?? item.name}`}
    >
      ◇
    </span>
  );
}
/** Expansion stays in normal document flow, so the row grows with its gear. */
export function RequestedItemStack({
  items,
  size = 38,
  alwaysExpanded = false,
  expandedLabel = "All requested items",
}: {
  items: StackItem[];
  size?: number;
  alwaysExpanded?: boolean;
  expandedLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return <span className={styles.empty}>◇</span>;
  return (
    <div
      data-requested-stack
      data-expanded={open || alwaysExpanded}
      className={styles.container}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {!alwaysExpanded && (
        <button
          type="button"
          className={`${styles.stack} ${open ? styles.expandedAnchor : ""}`}
          style={
            open
              ? undefined
              : {
                  width: size + Math.min(items.length - 1, 2) * 7,
                  height: size + Math.min(items.length - 1, 2) * 4,
                }
          }
          aria-label={`Show all ${items.length} requested items`}
          aria-expanded={open}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) setOpen(true);
          }}
          onClick={(event) => {
            event.stopPropagation();
            const pointer = event.nativeEvent as MouseEvent & {
              pointerType?: string;
            };
            setOpen((value) =>
              pointer.pointerType === "touch" ? !value : true,
            );
          }}
        >
          {open && <span>Requested equipment · {items.length}</span>}
          {!open &&
            items.slice(0, 3).map((item, index) => (
              <span
                key={`${index}-${item.name}`}
                className={styles.layer}
                style={{
                  width: size,
                  height: size,
                  left: index * 7,
                  top: index * 4,
                  zIndex: 3 - index,
                }}
              >
                <ItemImage item={item} />
              </span>
            ))}
          {!open && items.length > 1 && (
            <b className={styles.count}>{items.length}</b>
          )}
        </button>
      )}
      {(open || alwaysExpanded) && (
        <section
          className={styles.expansion}
          aria-label={expandedLabel}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item, index) => (
            <article key={`${index}-${item.name}`}>
              <ItemImage item={item} />
              <strong>{item.display_name ?? item.name}</strong>
              <small>
                {item.qty}× ·{" "}
                {item.origin === "chat" ? "Mentioned in chat" : "In basket"}
              </small>
            </article>
          ))}
          {!alwaysExpanded && (
            <button
              type="button"
              aria-label="Collapse requested items"
              className={styles.collapse}
              onClick={() => setOpen(false)}
            >
              Collapse equipment ↑
            </button>
          )}
        </section>
      )}
    </div>
  );
}
