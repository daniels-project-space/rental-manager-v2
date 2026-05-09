"use client";
import { useCountUp } from "@/hooks/useCountUp";

/**
 * Extracts numeric value from a string like "£1,234" or "45.2%" for count-up.
 * Returns null if the value isn't parseable as a standalone number.
 */
function parseNumeric(value: string | number): number | null {
  if (typeof value === "number") return value;
  // Strip currency/percent/k suffix and try to parse
  const clean = value.replace(/[£%,\s]/g, "").replace(/k$/i, "000");
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

function CountUpValue({
  raw,
  color,
  className = "",
}: {
  raw: string | number;
  color: string;
  className?: string;
}) {
  const numeric = parseNumeric(raw);
  const animated = useCountUp(numeric ?? 0, 600);

  if (numeric === null) {
    // Non-numeric (e.g. "ON"/"OFF") — render static
    return (
      <span className={className} style={{ color }}>
        {raw}
      </span>
    );
  }

  // Reconstruct the display string with the animated value
  const original = typeof raw === "string" ? raw : String(raw);
  const hasPrefix = original.startsWith("£");
  const hasSuffix = original.endsWith("%");
  const isDecimal = original.includes(".");
  const decimals = isDecimal ? (original.split(".")[1]?.replace(/[^0-9]/g, "").length ?? 0) : 0;

  const displayNum = isDecimal ? animated.toFixed(Math.min(decimals, 2)) : Math.round(animated).toString();
  const display = `${hasPrefix ? "£" : ""}${displayNum}${hasSuffix ? "%" : ""}`;

  return (
    <span className={className} style={{ color }}>
      {display}
    </span>
  );
}

export function MetricTile({
  label,
  value,
  color = "#6ea8fe",
  sub,
}: {
  label: string;
  value: string | number;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="glass-card rm-card p-4 stat-card-hover cursor-default flex flex-col gap-1">
      <span
        className="text-xs font-medium uppercase tracking-wider"
        style={{ color: "#8b8fa3" }}
      >
        {label}
      </span>
      <CountUpValue
        raw={value}
        color={color}
        className="text-3xl font-bold leading-tight"
      />
      {sub && (
        <span className="text-xs" style={{ color: "#8b8fa3" }}>
          {sub}
        </span>
      )}
    </div>
  );
}
