"use client";

/**
 * Polls the Worker's GET /status every 30-60s (build brief, section 5:
 * "polling is simpler and this repo already moved away from SSE for the
 * hosted path for good reason" — see docs/RUNTIME.md's "Real-time is gone"
 * section for that reasoning applied to `usePolledJson`, reused here
 * verbatim rather than reinventing a second real-time strategy).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStatus, WorkerApiError, type StatusResponse } from "./workerApi";

export interface WorkerStatusResult {
  data: StatusResponse | null;
  error: string | null;
  unauthorized: boolean;
  loading: boolean;
  lastFetchedAt: number | null;
  refresh: () => void;
}

export function useWorkerStatus(token: string | null, intervalMs = 45_000): WorkerStatusResult {
  const [state, setState] = useState<Omit<WorkerStatusResult, "refresh">>({
    data: null,
    error: null,
    unauthorized: false,
    loading: true,
    lastFetchedAt: null,
  });
  const mounted = useRef(true);
  const nonce = useRef(0);

  const load = useCallback(async () => {
    if (!token) return;
    const myNonce = ++nonce.current;
    try {
      const data = await fetchStatus(token);
      if (mounted.current && myNonce === nonce.current) {
        setState({ data, error: null, unauthorized: false, loading: false, lastFetchedAt: Date.now() });
      }
    } catch (err) {
      const unauthorized = err instanceof WorkerApiError && err.status === 401;
      const message = err instanceof Error ? err.message : String(err);
      if (mounted.current && myNonce === nonce.current) {
        setState((prev) => ({ ...prev, error: message, unauthorized, loading: false, lastFetchedAt: Date.now() }));
      }
    }
  }, [token]);

  useEffect(() => {
    mounted.current = true;
    if (!token) return undefined;
    void load();
    const id = window.setInterval(() => void load(), intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [load, token, intervalMs]);

  return { ...state, refresh: () => void load() };
}

export default useWorkerStatus;
