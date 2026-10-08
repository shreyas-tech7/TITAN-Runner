"use client";

import { useEffect, useRef, useState } from "react";

/** Copy a text to the clipboard. The label says what was copied. If the browser refuses, the button says so. */
export default function CopyButton({ text, label = "Copy", what = "text", className = "btn btn-quiet" }: { text: string; label?: string; what?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={`${label} ${what}`}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label}</span>
    </button>
  );
}
