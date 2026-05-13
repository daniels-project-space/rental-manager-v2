"use client";

import { useState, useId } from "react";

export type StatCardStatus = "normal" | "warn" | "danger" | "success" | "info";
export type StatCardColor = "green" | "amber" | "blue" | "purple" | "red";

export interface ExpandableStatCardProps {
  id: string;
  label: string;
  value: React.ReactNode;
  /** Optional inline accent next to the value (e.g. "+£68" pending) */
  valueSuffix?: React.ReactNode;
  valueColor?: StatCardColor;
  accentColor?: StatCardColor;
  isExpanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  hero?: boolean;
  status?: StatCardStatus;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Content shown below subtitle and ALWAYS visible (collapsed + expanded).
   *  Used for in-card visualisations like the v1 segmented bar / progress bar. */
  headerExtra?: React.ReactNode;
  className?: string;
}

const COLOR_HEX: Record<StatCardColor, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  blue: "#6ea8fe",
  purple: "#a78bfa",
  red: "#ef4444",
};

export default function ExpandableStatCard(props: ExpandableStatCardProps) {
  const drawerId = useId();
  const [everExpanded, setEverExpanded] = useState(props.isExpanded);

  if (props.isExpanded && !everExpanded) {
    setEverExpanded(true);
  }

  const valueHex = props.valueColor ? COLOR_HEX[props.valueColor] : undefined;
  const accentHex = props.accentColor ? COLOR_HEX[props.accentColor] : undefined;

  return (
    <div
      className={`stat-card hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(110,168,254,0.1)] active:scale-[0.99] ${props.hero ? "col-span-2" : ""} ${props.className ?? ""}`}
      style={{
        background: "rgba(14,17,28,0.35)",
        backdropFilter: "blur(24px) saturate(1.5)",
        borderRadius: 16,
        padding: 16,
        borderLeft: accentHex ? `3px solid ${accentHex}` : undefined,
        transition: "transform 0.2s ease, box-shadow 0.2s ease",
      }}
    >
      {/* Header — clickable */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={props.isExpanded}
        aria-controls={drawerId}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggle();
          }
        }}
        className="stat-card-header cursor-pointer flex items-start justify-between gap-2 select-none"
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400 uppercase tracking-wider leading-none">
            {props.label}
          </div>
          <div
            className="text-2xl font-semibold mt-1 flex items-baseline gap-1.5"
            style={{
              color: valueHex,
              textShadow: valueHex ? `0 0 12px ${valueHex}40` : undefined,
            }}
          >
            {props.icon && (
              <span className="inline-flex items-center self-center">{props.icon}</span>
            )}
            <span>{props.value}</span>
            {props.valueSuffix && (
              <span className="text-base font-medium">{props.valueSuffix}</span>
            )}
          </div>
          {props.subtitle && (
            <div className="text-xs text-slate-500 mt-1">{props.subtitle}</div>
          )}
        </div>

        {/* Chevron */}
        <span
          className="text-slate-500 text-base leading-none mt-0.5 flex-shrink-0 transition-transform duration-300"
          style={{
            transform: props.isExpanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
          aria-hidden="true"
        >
          ▾
        </span>
      </div>

      {props.headerExtra && (
        <div className="mt-3">{props.headerExtra}</div>
      )}

      {/* Drawer */}
      <div
        id={drawerId}
        className="stat-card-drawer"
        style={{
          maxHeight: props.isExpanded ? 720 : 0,
          opacity: props.isExpanded ? 1 : 0,
          marginTop: props.isExpanded ? 12 : 0,
          overflow: props.isExpanded ? "visible" : "hidden",
          transition:
            "max-height 350ms ease, opacity 250ms ease, margin-top 250ms ease",
        }}
      >
        {everExpanded ? props.children : null}
      </div>
    </div>
  );
}
