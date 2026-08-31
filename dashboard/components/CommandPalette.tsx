"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export default function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after the modal mounts.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) {
        onClose();
        cmd.run();
      }
    }
  }

  return (
    <div className="overlay-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          aria-label="Command search"
        />
        <ul>
          {filtered.length === 0 && (
            <li>
              <span className="text-quiet" style={{ padding: 10, display: "block" }}>
                No matching command.
              </span>
            </li>
          )}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                data-active={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  onClose();
                  c.run();
                }}
              >
                <span>{c.label}</span>
                {c.hint && <span className="text-quiet mono">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
