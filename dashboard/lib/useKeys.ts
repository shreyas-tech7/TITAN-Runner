"use client";

/**
 * Polls `GET /admin/keys`. It also gives a fast mode (every 5 seconds) for a short time, which the Keys page uses
 * while a runner test is on its way.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchKeys, type KeysResponse } from "./keysApi";
import { WorkerApiError } from "./workerApi";

export interface UseKeysResult {
  data: KeysResponse | null;
  error: string | null;
  unauthorized: boolean;
  loading: boolean;
  refresh: () => void;
  /** Poll every 5 seconds for `ms` milliseconds. */
  fastFor: (ms: number) => void;
}

export function useKeys(token: string | null, intervalMs = 60_000): UseKeysResult {
  const [data, setData] = useState<KeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fastUntil, setFastUntil] = useState(0);
  const mounted = useRef(true);
  const nonce = useRef(0);

  const load = useCallback(async () => {
    if (!token) return;
    const mine = ++nonce.current;
    try {
      const next = await fetchKeys(token);
      if (mounted.current && mine === nonce.current) {
        setData(next);
        setError(null);
        setUnauthorized(false);
        setLoading(false);
      }
    } catch (err) {
      if (mounted.current && mine === nonce.current) {
        setUnauthorized(err instanceof WorkerApiError && err.status === 401);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    mounted.current = true;
    if (!token) return undefined;
    void load();
    const fast = Date.now() < fastUntil;
    const id = window.setInterval(() => void load(), fast ? 5_000 : intervalMs);
    const stop = fast ? window.setTimeout(() => setFastUntil(0), Math.max(0, fastUntil - Date.now())) : undefined;
    return () => {
      mounted.current = false;
      window.clearInterval(id);
      if (stop) window.clearTimeout(stop);
    };
  }, [load, token, intervalMs, fastUntil]);

  return { data, error, unauthorized, loading, refresh: () => void load(), fastFor: (ms) => setFastUntil(Date.now() + ms) };
}
