"use client";

/**
 * Weather for Dallas, TX via Open-Meteo — free, keyless, CORS-enabled, and
 * happy to be called straight from the browser, which matters here: this
 * dashboard is a static export with no server of its own (same reason
 * `usePolledJson` polls raw.githubusercontent.com directly). No new runtime
 * dependency; this is a fetch() call and a small WMO code table.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const DALLAS = { lat: 32.7767, lon: -96.797, label: "Dallas, TX" };

const ENDPOINT =
  `https://api.open-meteo.com/v1/forecast?latitude=${DALLAS.lat}&longitude=${DALLAS.lon}` +
  `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m` +
  `&daily=temperature_2m_max,temperature_2m_min` +
  `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=1`;

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    is_day: 0 | 1;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

export interface WeatherSnapshot {
  place: string;
  tempF: number;
  feelsLikeF: number;
  humidity: number;
  windMph: number;
  isDay: boolean;
  condition: string;
  icon: WeatherIcon;
  highF: number;
  lowF: number;
  observedAt: string;
}

export type WeatherIcon = "clear" | "partly-cloudy" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "thunderstorm";

/** WMO weather interpretation codes — https://open-meteo.com/en/docs, "WMO Weather interpretation codes" table. */
function describeWeatherCode(code: number): { condition: string; icon: WeatherIcon } {
  const table: Record<number, { condition: string; icon: WeatherIcon }> = {
    0: { condition: "Clear sky", icon: "clear" },
    1: { condition: "Mostly clear", icon: "clear" },
    2: { condition: "Partly cloudy", icon: "partly-cloudy" },
    3: { condition: "Overcast", icon: "cloudy" },
    45: { condition: "Fog", icon: "fog" },
    48: { condition: "Rime fog", icon: "fog" },
    51: { condition: "Light drizzle", icon: "drizzle" },
    53: { condition: "Drizzle", icon: "drizzle" },
    55: { condition: "Dense drizzle", icon: "drizzle" },
    56: { condition: "Freezing drizzle", icon: "drizzle" },
    57: { condition: "Freezing drizzle", icon: "drizzle" },
    61: { condition: "Light rain", icon: "rain" },
    63: { condition: "Rain", icon: "rain" },
    65: { condition: "Heavy rain", icon: "rain" },
    66: { condition: "Freezing rain", icon: "rain" },
    67: { condition: "Freezing rain", icon: "rain" },
    71: { condition: "Light snow", icon: "snow" },
    73: { condition: "Snow", icon: "snow" },
    75: { condition: "Heavy snow", icon: "snow" },
    77: { condition: "Snow grains", icon: "snow" },
    80: { condition: "Rain showers", icon: "rain" },
    81: { condition: "Rain showers", icon: "rain" },
    82: { condition: "Violent rain showers", icon: "rain" },
    85: { condition: "Snow showers", icon: "snow" },
    86: { condition: "Heavy snow showers", icon: "snow" },
    95: { condition: "Thunderstorm", icon: "thunderstorm" },
    96: { condition: "Thunderstorm with hail", icon: "thunderstorm" },
    99: { condition: "Thunderstorm with hail", icon: "thunderstorm" },
  };
  return table[code] ?? { condition: "Unknown", icon: "cloudy" };
}

export async function fetchDallasWeather(signal?: AbortSignal): Promise<WeatherSnapshot> {
  const res = await fetch(ENDPOINT, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`Weather service responded ${res.status}`);
  const body = (await res.json()) as OpenMeteoResponse;
  const { condition, icon } = describeWeatherCode(body.current.weather_code);
  // `current.time` comes back as a Chicago-local, offset-less string (we
  // asked for timezone=America/Chicago) — parsing that with Date.parse in a
  // browser outside Central time silently applies the wrong offset. The
  // fetch's own completion time is what "observed ago" actually means to a
  // viewer anyway, and it is unambiguous.
  return {
    place: DALLAS.label,
    tempF: Math.round(body.current.temperature_2m),
    feelsLikeF: Math.round(body.current.apparent_temperature),
    humidity: Math.round(body.current.relative_humidity_2m),
    windMph: Math.round(body.current.wind_speed_10m),
    isDay: body.current.is_day === 1,
    condition,
    icon,
    highF: Math.round(body.daily.temperature_2m_max[0]),
    lowF: Math.round(body.daily.temperature_2m_min[0]),
    observedAt: new Date().toISOString(),
  };
}

export interface WeatherResult {
  data: WeatherSnapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useWeather(intervalMs = 10 * 60_000): WeatherResult {
  const [data, setData] = useState<WeatherSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const nonce = useRef(0);

  const load = useCallback(async () => {
    const myNonce = ++nonce.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const snapshot = await fetchDallasWeather(controller.signal);
      if (mounted.current && myNonce === nonce.current) {
        setData(snapshot);
        setError(null);
        setLoading(false);
      }
    } catch (err) {
      if (mounted.current && myNonce === nonce.current) {
        setError(err instanceof Error ? err.message : "Could not reach the weather service.");
        setLoading(false);
      }
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const id = window.setInterval(() => void load(), intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: () => void load() };
}
