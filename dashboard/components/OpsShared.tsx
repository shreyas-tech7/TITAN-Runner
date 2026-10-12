"use client";

/** Small parts that every ops panel uses: the freshness badge and the loading, error, and empty lines. */
import type { ReactNode } from "react";
import { Badge } from "@/components/kit";
import { isStale } from "@/lib/opsView";
import { relative } from "@/lib/time";

export interface MirrorInput<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** "updated 3h ago", and a warning tone when the file is older than it should be. */
export function Freshness({ at, maxAgeMs, now }: { at: string | null | undefined; maxAgeMs: number; now?: number }) {
  if (!at) return null;
  const stale = isStale(at, maxAgeMs, now);
  return (
    <Badge tone={stale ? "warn" : "neutral"} title={`${at}${stale ? ". This is older than expected." : ""}`}>
      {stale ? "stale, " : ""}updated {relative(at, now)}
    </Badge>
  );
}

/**
 * The body of a panel that reads one public file. It prints the loading line, the error line, or the empty line
 * when there is nothing to show, and the children otherwise.
 */
export function MirrorBody<T>({
  input, what, emptyText, isEmpty, children,
}: {
  input: MirrorInput<T>;
  what: string;
  emptyText: string;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (input.loading && !input.data) return <p className="e-dim">Loading {what}…</p>;
  if (!input.data && input.error) {
    return (
      <p className="e-dim" role="alert">
        Could not load {what} ({input.error}).
      </p>
    );
  }
  if (!input.data || isEmpty(input.data)) return <p className="e-dim">{emptyText}</p>;
  return <>{children(input.data)}</>;
}
