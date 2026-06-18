"use client";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Card } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Ported Listings — dashboard widget (Phase 5, Wave 2).
//
// Surfaces dbcinema catalog products MISSING on the leo account and tracks the
// state of porting each one's listing image into R2 with the leo gradient
// background. Reads three Convex queries (live):
//   - ported_listings.diff      → {missing[], counts{dbTotal,leoTotal,missingCount}}
//   - ported_listings.list      → ported_listings rows (status: pending|ported|error)
//   - ported_listings.getConfig → detected leo gradient profile (swatches/orientation) | null
//
// Two POST actions drive the VPS batch:
//   - /api/port-listings/detect-gradient → samples leo, returns {orientation,swatches}
//   - /api/port-listings/run             → kicks the porting batch, returns {started,count}
// Rows live-update via useQuery as the VPS writes them. Read-only over the
// catalog; this widget never mutates inventory or the poll path.

type PortedRow = {
  _id: string;
  productId: string;
  name: string;
  dbImageUrl: string;
  status: "pending" | "ported" | "error";
  portedR2Key?: string;
  portedUrl?: string;
  error?: string;
  updatedAt: number;
};

// Inline icon — the dashboard intentionally avoids an icon dependency
// (lucide is not installed); existing panels use plain glyphs/SVG.
function ImagesIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 13 3-3 4 4" />
      <path d="M17 8h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-2" />
    </svg>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function sanitizeFilename(name: string): string {
  return (
    (name || "listing")
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase()
      .slice(0, 80) || "listing"
  );
}

function StatusBadge({ row }: { row: PortedRow }) {
  if (row.status === "ported") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium"
        style={{ background: "rgba(34,197,94,0.14)", color: "#22c55e" }}
      >
        Ported
      </span>
    );
  }
  if (row.status === "error") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium cursor-help inline-flex items-center gap-1"
        style={{ background: "rgba(239,68,68,0.14)", color: "#ef4444" }}
        title={row.error || "Porting failed"}
      >
        Error
      </span>
    );
  }
  return (
    <span
      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
      style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}
    >
      <Spinner className="text-[#6ea8fe]" />
      Pending
    </span>
  );
}

export function PortedListingsPanel() {
  const diff = useQuery(api.ported_listings.diff, {});
  const rows = useQuery(api.ported_listings.list, {}) as
    | PortedRow[]
    | undefined;
  const config = useQuery(api.ported_listings.getConfig, { key: "leo" });

  const [detecting, setDetecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const loading =
    diff === undefined || rows === undefined || config === undefined;

  const counts = diff?.counts;
  const swatches: string[] = config?.swatches ?? [];
  const orientation: string | undefined = config?.orientation ?? undefined;
  const hasGradient = swatches.length > 0;

  const portedRows = useMemo(
    () => (rows ?? []).filter((r) => r.status === "ported" && r.portedUrl),
    [rows],
  );

  const gradientCss = useMemo(() => {
    if (swatches.length === 0) return undefined;
    const stops =
      swatches.length === 1
        ? `${swatches[0]}, ${swatches[0]}`
        : swatches.join(", ");
    const dir =
      orientation === "horizontal"
        ? "to right"
        : orientation === "diagonal"
          ? "135deg"
          : "to bottom";
    return `linear-gradient(${dir}, ${stops})`;
  }, [swatches, orientation]);

  async function detectGradient() {
    setActionErr(null);
    setActionMsg(null);
    setDetecting(true);
    try {
      const res = await fetch("/api/port-listings/detect-gradient", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`detect failed (${res.status})`);
      const data = (await res.json()) as {
        orientation?: string;
        swatches?: string[];
      };
      const n = data.swatches?.length ?? 0;
      setActionMsg(
        n > 0
          ? `Detected ${n} swatch${n === 1 ? "" : "es"}${data.orientation ? ` · ${data.orientation}` : ""}`
          : "Detection returned no swatches",
      );
      // config useQuery live-updates once setConfig lands in Convex.
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setDetecting(false);
    }
  }

  async function runPort() {
    if (!hasGradient) return;
    const n = counts?.missingCount ?? 0;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Run port for ${n} missing listing${n === 1 ? "" : "s"}? This generates ported images into R2.`,
      )
    ) {
      return;
    }
    setActionErr(null);
    setActionMsg(null);
    setRunning(true);
    try {
      const res = await fetch("/api/port-listings/run", { method: "POST" });
      if (!res.ok) throw new Error(`run failed (${res.status})`);
      const data = (await res.json()) as {
        started?: boolean;
        count?: number;
      };
      setActionMsg(
        `Started porting ${data.count ?? n} listing${(data.count ?? n) === 1 ? "" : "s"} — rows update live below.`,
      );
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function downloadAllZip() {
    if (portedRows.length === 0) return;
    setActionErr(null);
    setZipping(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const used = new Set<string>();
      await Promise.all(
        portedRows.map(async (r) => {
          try {
            const resp = await fetch(r.portedUrl as string);
            if (!resp.ok) return;
            const blob = await resp.blob();
            let base = sanitizeFilename(r.name);
            let fname = `${base}.png`;
            let i = 2;
            while (used.has(fname)) fname = `${base}-${i++}.png`;
            used.add(fname);
            zip.file(fname, blob);
          } catch {
            /* skip individual failures */
          }
        }),
      );
      const out = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(out);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ported-listings.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "ZIP failed");
    } finally {
      setZipping(false);
    }
  }

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[#6ea8fe]">
              <ImagesIcon />
            </span>
            <span className="text-sm font-semibold text-[#e4e6eb]">
              Ported Listings
            </span>
          </div>
          <div className="text-xs text-[#8b8fa3] mt-0.5">
            {loading ? (
              "Loading catalog diff…"
            ) : (
              <span className="flex items-center gap-x-3 gap-y-0.5 flex-wrap">
                <span>DB Cinema {counts?.dbTotal ?? 0}</span>
                <span className="text-[#3a3f52]">·</span>
                <span>Leo {counts?.leoTotal ?? 0}</span>
                <span className="text-[#3a3f52]">·</span>
                <span style={{ color: "#f59e0b" }}>
                  Missing {counts?.missingCount ?? 0}
                </span>
                <span className="text-[#3a3f52]">·</span>
                <span style={{ color: "#22c55e" }}>
                  Ported {portedRows.length}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Gradient section */}
      <div
        className="mt-4 pt-3 border-t"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="text-[11px] uppercase tracking-wide text-[#8b8fa3] mb-2">
          Leo gradient
        </div>
        {loading ? (
          <SkeletonBlock className="h-10 w-full rounded-lg" />
        ) : hasGradient ? (
          <div className="flex items-center gap-3 flex-wrap">
            <div
              className="h-9 flex-1 min-w-[140px] rounded-lg border"
              style={{
                background: gradientCss,
                borderColor: "rgba(255,255,255,0.08)",
              }}
              aria-label="Detected leo gradient"
            />
            <div className="flex items-center gap-1.5">
              {swatches.slice(0, 8).map((hex, i) => (
                <span
                  key={`${hex}-${i}`}
                  className="w-5 h-5 rounded border"
                  style={{
                    background: hex,
                    borderColor: "rgba(255,255,255,0.12)",
                  }}
                  title={hex}
                />
              ))}
            </div>
            <span className="text-xs text-[#8b8fa3]">
              {swatches.length} swatch{swatches.length === 1 ? "" : "es"}
              {orientation ? ` · ${orientation}` : ""}
            </span>
            <button
              type="button"
              onClick={detectGradient}
              disabled={detecting}
              className="text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50"
              style={{
                borderColor: "rgba(110,168,254,0.3)",
                color: "#6ea8fe",
                background: "rgba(110,168,254,0.08)",
              }}
            >
              {detecting ? "Detecting…" : "Re-detect"}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-[#8b8fa3]">
              No gradient profile yet — detect the leo background gradient first.
            </span>
            <button
              type="button"
              onClick={detectGradient}
              disabled={detecting}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
              style={{ background: "#6ea8fe", color: "#0b0f1c" }}
            >
              {detecting ? "Detecting…" : "Detect Leo gradient"}
            </button>
          </div>
        )}
      </div>

      {/* Action: Run port */}
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={runPort}
          disabled={!hasGradient || running || loading}
          title={
            !hasGradient ? "Detect the leo gradient first" : "Run the porting batch"
          }
          className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          style={{ background: "#22c55e", color: "#04210f" }}
        >
          {running ? <Spinner className="text-[#04210f]" /> : null}
          {running
            ? "Starting…"
            : `Run port${counts?.missingCount ? ` (${counts.missingCount})` : ""}`}
        </button>
        {portedRows.length > 0 && (
          <button
            type="button"
            onClick={downloadAllZip}
            disabled={zipping}
            className="text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            style={{
              borderColor: "rgba(255,255,255,0.12)",
              color: "#e4e6eb",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            {zipping ? <Spinner className="text-[#e4e6eb]" /> : null}
            {zipping ? "Zipping…" : `Download all (ZIP · ${portedRows.length})`}
          </button>
        )}
      </div>

      {(actionMsg || actionErr) && (
        <div
          className="mt-3 text-xs px-3 py-2 rounded-lg"
          style={
            actionErr
              ? { background: "rgba(239,68,68,0.1)", color: "#ef4444" }
              : { background: "rgba(34,197,94,0.1)", color: "#22c55e" }
          }
        >
          {actionErr || actionMsg}
        </div>
      )}

      {/* Results grid */}
      <div
        className="mt-4 pt-3 border-t"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="text-[11px] uppercase tracking-wide text-[#8b8fa3] mb-2">
          Listings
        </div>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <SkeletonBlock key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : (rows ?? []).length === 0 ? (
          <div className="text-xs text-[#8b8fa3] py-3">
            No ported listings yet.{" "}
            {hasGradient
              ? "Hit “Run port” to start processing the missing listings."
              : "Detect the leo gradient, then run the port."}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(rows ?? []).map((row) => (
              <div
                key={row._id ?? row.productId}
                className="rounded-lg border p-3"
                style={{
                  borderColor: "rgba(255,255,255,0.07)",
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="text-sm text-[#e4e6eb] truncate min-w-0">
                    {row.name || row.productId}
                  </span>
                  <span className="flex-shrink-0">
                    <StatusBadge row={row} />
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {/* Original */}
                  <figure className="m-0">
                    <div
                      className="aspect-square w-full rounded-md overflow-hidden flex items-center justify-center"
                      style={{ background: "#0b0f1c" }}
                    >
                      {row.dbImageUrl ? (
                        <img
                          src={row.dbImageUrl}
                          alt={`${row.name} original`}
                          className="w-full h-full object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <span className="text-[10px] text-[#6b6f80]">
                          no image
                        </span>
                      )}
                    </div>
                    <figcaption className="text-[10px] text-[#6b6f80] mt-1 text-center">
                      Original
                    </figcaption>
                  </figure>

                  {/* Ported */}
                  <figure className="m-0">
                    <div
                      className="aspect-square w-full rounded-md overflow-hidden flex items-center justify-center"
                      style={{ background: "#0b0f1c" }}
                    >
                      {row.status === "ported" && row.portedUrl ? (
                        <img
                          src={row.portedUrl}
                          alt={`${row.name} ported`}
                          className="w-full h-full object-contain"
                          loading="lazy"
                        />
                      ) : row.status === "error" ? (
                        <span
                          className="text-[10px] px-1 text-center"
                          style={{ color: "#ef4444" }}
                          title={row.error || "Porting failed"}
                        >
                          failed
                        </span>
                      ) : (
                        <Spinner className="text-[#6ea8fe]" />
                      )}
                    </div>
                    <figcaption className="text-[10px] text-[#6b6f80] mt-1 text-center">
                      Ported
                    </figcaption>
                  </figure>
                </div>

                {row.status === "ported" && row.portedUrl && (
                  <a
                    href={row.portedUrl}
                    download={`${sanitizeFilename(row.name)}.png`}
                    className="mt-2 block text-center text-[11px] px-2 py-1 rounded-md border transition-colors"
                    style={{
                      borderColor: "rgba(110,168,254,0.3)",
                      color: "#6ea8fe",
                      background: "rgba(110,168,254,0.06)",
                    }}
                  >
                    Download PNG
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
