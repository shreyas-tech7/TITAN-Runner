"use client";

/**
 * One polling hook, reused for every state file this dashboard shows.
 *
 * A static export has no server behind it, so "live" here means client-side
 * polling rather than SSE (the private TITAN dashboard's live pipeline view
 * uses an EventSource against its own backend — this repo has no backend to
 * hold that connection open, hence polling; see docs/RUNTIME.md's
 * "Real-time is gone, replaced honestly" section).
 *
 * Tries the raw GitHub URL first (always current, works from any origin)
 * and falls back to the same-origin copy this app's own build baked into
 * `public/state/` (`scripts/copy-state.mjs`) — so the page still shows the
 * state as of the last dashboard build even if raw.githubusercontent.com is
 * unreachable or rate-limited.
 */
import { useEffect, useRef, useState } from "react";

const OWNER = process.env.NEXT_PUBLIC_GITHUB_OWNER || "";
const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO || "";
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

function rawUrl(path: string): string | null {
  if (!OWNER || !REPO) return null;
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${path}?t=${Date.now()}`;
}

function localUrl(path: string): string {
  return `${BASE_PATH}/state/${path.replace(/^state\//, "")}`;
}

export interface PolledJsonResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  source: "live" | "build" | null;
}

/**
 * @param statePath e.g. "state/heartbeat.json"
 * @param intervalMs how often to re-poll; 0 disables polling (fetch once)
 */
export function usePolledJson<T>(statePath: string, intervalMs = 20_000): PolledJsonResult<T> {
  const [result, setResult] = useState<PolledJsonResult<T>>({
    data: null,
    error: null,
    loading: true,
    source: null,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    async function load() {
      const remote = rawUrl(statePath);
      if (remote) {
        // A hung connection (a proxy with no route to raw.githubusercontent.com,
        // a flaky network) must not block the local fallback indefinitely —
        // fetch() has no default timeout, so this needs an explicit one.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4_000);
        try {
          const res = await fetch(remote, { cache: "no-store", signal: controller.signal });
          if (res.ok) {
            const data = (await res.json()) as T;
            if (mounted.current) setResult({ data, error: null, loading: false, source: "live" });
            return;
          }
        } catch {
          // fall through to the build-time copy
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        const res = await fetch(localUrl(statePath), { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as T;
          if (mounted.current) setResult({ data, error: null, loading: false, source: "build" });
          return;
        }
        throw new Error(`local copy responded ${res.status}`);
      } catch (err) {
        if (mounted.current) {
          setResult((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          }));
        }
      }
    }

    void load();
    if (intervalMs > 0) {
      const id = window.setInterval(() => void load(), intervalMs);
      return () => {
        mounted.current = false;
        window.clearInterval(id);
      };
    }
    return () => {
      mounted.current = false;
    };
  }, [statePath, intervalMs]);

  return result;
}

export default usePolledJson;
