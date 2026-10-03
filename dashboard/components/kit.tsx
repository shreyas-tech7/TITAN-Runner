"use client";

/**
 * A small version of the TITAN dashboard's Eclipse kit: Panel, Badge, StatusDot, Meter, Sparkline.
 * Colors come only from the tokens in app/tokens.css, and a status is always a word as well as a color.
 */
import type { ReactNode } from "react";

export type Tone = "ion" | "plasma" | "corona" | "ok" | "warn" | "danger" | "neutral";

export function Panel({
  title,
  eyebrow,
  actions,
  tone,
  className = "",
  children,
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  /** Tints the top edge: ion is the system, plasma is the agents, corona is you. */
  tone?: "ion" | "plasma" | "corona";
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`e-panel ${tone ? `e-panel-${tone}` : ""} ${className}`} aria-label={title}>
      <header className="e-panel-head">
        <div className="e-panel-titles">
          {eyebrow ? <p className="e-eyebrow">{eyebrow}</p> : null}
          <h2 className="e-panel-title">{title}</h2>
        </div>
        {actions ? <div className="e-panel-actions">{actions}</div> : null}
      </header>
      <div className="e-panel-body">{children}</div>
    </section>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`e-badge e-badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusDot({ tone = "ok", pulse = false, label }: { tone?: Tone; pulse?: boolean; label: string }) {
  return <span role="img" aria-label={label} className={`e-dot e-dot-${tone} ${pulse ? "e-dot-pulse" : ""}`} />;
}

/** A bar with a number beside it. `marker` draws a tick, such as the share held in reserve. */
export function Meter({ value, max, label, tone, marker, text }: { value: number; max: number; label: string; tone?: Tone; marker?: number; text?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const auto: Tone = tone ?? (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok");
  return (
    <div className="e-meter">
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={text ?? `${Math.round(value)} of ${max}`} className="e-meter-track">
        <div className={`e-meter-fill e-fill-${auto}`} style={{ width: `${pct}%` }} />
        {marker !== undefined ? <div className="e-meter-marker" style={{ left: `${Math.min(100, Math.max(0, (marker / max) * 100))}%` }} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/** A line over a short series. The summary is for screen readers. */
export function Sparkline({ values, width = 160, height = 36, label, tone = "ion" }: { values: number[]; width?: number; height?: number; label: string; tone?: Tone }) {
  if (values.length === 0) return <span className="e-dim">No data for {label}</span>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(3 + i * step).toFixed(1)},${(height - 4 - ((v - lo) / span) * (height - 8)).toFixed(1)}`);
  return (
    <svg role="img" aria-label={`${label}: ${values.length} points, low ${lo}, high ${hi}, latest ${values[values.length - 1]}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`e-spark e-stroke-${tone}`}>
      <polyline points={pts.join(" ")} fill="none" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
