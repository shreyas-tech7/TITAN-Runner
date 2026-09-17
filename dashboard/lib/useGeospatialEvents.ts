"use client";

/**
 * Shared by the main dashboard's embedded God's Eye hero panel and the
 * full `/ops/geospatial` detail page — one polling implementation for
 * GET /geospatial/events instead of two copies drifting apart.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchGeospatialEvents, isWorkerConfigured, WorkerApiError, type GeospatialEventRow } from "./workerApi";

export interface GeospatialEventsResult {
  events: GeospatialEventRow[] | null;
  error: string | null;
  configured: boolean;
  refresh: () => void;
}

export function useGeospatialEvents(token: string | null, intervalMs = 20_000): GeospatialEventsResult {
  const [events, setEvents] = useState<GeospatialEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = isWorkerConfigured();

  const load = useCallback(async () => {
    if (!token || !configured) return;
    try {
      const result = await fetchGeospatialEvents(token);
      setEvents(result.events);
      setError(null);
    } catch (err) {
      setError(err instanceof WorkerApiError ? err.message : "Could not reach the Worker.");
    }
  }, [token, configured]);

  useEffect(() => {
    if (!token || !configured) return undefined;
    void load();
    const id = window.setInterval(() => void load(), intervalMs);
    return () => window.clearInterval(id);
  }, [load, token, configured, intervalMs]);

  return { events, error, configured, refresh: () => void load() };
}
