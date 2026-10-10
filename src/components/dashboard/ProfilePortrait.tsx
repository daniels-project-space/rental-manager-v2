"use client";
import { useEffect, useRef, useState } from "react";
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
  const closeButton = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (preview !== "full") return;
    const previous = document.activeElement;
    const visual = window.visualViewport;
    const update = () =>
      setViewport({
        top: visual?.offsetTop ?? 0,
        left: visual?.offsetLeft ?? 0,
        width: visual?.width ?? innerWidth,
        height: visual?.height ?? innerHeight,
      });
    update();
    closeButton.current?.focus({ preventScroll: true });
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [preview]);
  useEffect(() => {
    setFailed(false);
    setPreview(null);
  }, [src]);
  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPreview(null);
      } else if (preview === "full" && event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        closeButton.current?.focus({ preventScroll: true });
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
              style={
                viewport
                  ? {
                      top: viewport.top,
                      left: viewport.left,
                      width: viewport.width,
                      height: viewport.height,
                      bottom: "auto",
                      right: "auto",
                    }
                  : undefined
              }
              onClick={(event) => {
                event.stopPropagation();
                setPreview(null);
              }}
            >
              <button
                type="button"
                ref={closeButton}
                className={styles.close}
                aria-label="Close profile image"
                onClick={() => setPreview(null)}
              >
                ×
              </button>
              <img
                src={src}
                alt={name}
                className={styles.full}
                style={
                  viewport
                    ? {
                        maxWidth: Math.max(60, viewport.width - 40),
                        maxHeight: Math.max(40, viewport.height - 100),
                      }
                    : undefined
                }
              />
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
