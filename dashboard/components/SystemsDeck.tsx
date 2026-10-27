"use client";

/**
 * The Systems Deck: the dashboard panels in a collapsible dock under the assistant. It is closed at first, so the
 * assistant stays the focus. Only the open tab renders, so a closed deck does not poll anything.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { DECK_TABS, type DeckTab } from "@/lib/core";

export default function SystemsDeck({
  open,
  active,
  onToggle,
  onSelect,
  summary,
  children,
}: {
  open: boolean;
  active: DeckTab;
  onToggle: () => void;
  onSelect: (tab: DeckTab) => void;
  /** A short status for the closed bar, such as "3 tasks queued". */
  summary: string;
  children: ReactNode;
}) {
  return (
    <section className={`systems-deck ${open ? "systems-deck-open" : ""}`} aria-label="Systems Deck">
      <div className="deck-bar">
        <button type="button" className="deck-toggle" aria-expanded={open} aria-controls={open ? "deck-body" : undefined} onClick={onToggle}>
          <span className="deck-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="deck-title">System Monitor</span>
          <span className="deck-summary">{summary}</span>
        </button>
        <div className="deck-tabs" role="tablist" aria-label="System Monitor views">
          {DECK_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`deck-tab-${t.id}`} aria-selected={open && active === t.id} aria-controls={open ? "deck-body" : undefined} className="deck-tab" onClick={() => onSelect(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <nav className="deck-links" aria-label="Other systems">
          <Link className="deck-tab deck-link" href="/health">
            Health ↗
          </Link>
          <Link className="deck-tab deck-link" href="/connectors">
            Connectors ↗
          </Link>
        </nav>
      </div>
      {open ? (
        <div className="deck-body" id="deck-body" role="tabpanel" aria-labelledby={`deck-tab-${active}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
