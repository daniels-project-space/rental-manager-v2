"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ProfilePortrait.module.css";

/** Render the actual provider photo outside every ancestor clipping frame. */
export function ProfilePortrait({
  src,
  name,
  className,
}: {
  src?: string | null;
  name: string;
  className?: string;
}) {
  const [preview, setPreview] = useState<
    { left: number; top: number } | "full" | null
  >(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setPreview(null);
  }, [src]);
  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPreview(null);
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [preview]);
  const photo = src && !failed;
  return (
    <>
      <button
        type="button"
        className={`${className ?? ""} ${styles.trigger}`}
        disabled={!photo}
        aria-label={`Expand profile image of ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          if (photo) setPreview("full");
        }}
        onMouseEnter={(event) => {
          if (!photo || matchMedia("(hover: none)").matches) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setPreview({
            left: Math.max(8, Math.min(innerWidth - 228, rect.right + 8)),
            top: Math.max(8, Math.min(innerHeight - 228, rect.top)),
          });
        }}
        onMouseLeave={() =>
          setPreview((value) => (value === "full" ? value : null))
        }
      >
        {photo ? (
          <img
            src={src}
            alt={name}
            onError={() => {
              setFailed(true);
              setPreview(null);
            }}
          />
        ) : (
          <span>
            {name
              .split(" ")
              .map((part) => part[0])
              .slice(0, 2)
              .join("")}
          </span>
        )}
      </button>
      {photo &&
        preview &&
        createPortal(
          preview === "full" ? (
            <div
              className={styles.backdrop}
              role="dialog"
              aria-modal="true"
              aria-label={`Profile image of ${name}`}
              onClick={() => setPreview(null)}
            >
              <button
                type="button"
                className={styles.close}
                aria-label="Close profile image"
                onClick={() => setPreview(null)}
              >
                ×
              </button>
              <img src={src} alt={name} className={styles.full} />
            </div>
          ) : (
            <div
              className={styles.preview}
              style={{ left: preview.left, top: preview.top }}
              aria-hidden="true"
            >
              <img src={src} alt="" />
            </div>
          ),
          document.body,
        )}
    </>
  );
}
