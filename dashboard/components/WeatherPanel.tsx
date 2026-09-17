"use client";

import { useWeather, type WeatherIcon } from "@/lib/weather";
import { relative } from "@/lib/time";

function WeatherGlyph({ icon, isDay }: { icon: WeatherIcon; isDay: boolean }) {
  const stroke = "var(--text-0)";
  const accent = "var(--accent)";
  const common = { fill: "none", stroke, strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  if (icon === "clear" && isDay) {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <circle cx="12" cy="12" r="4.5" {...common} stroke={accent} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
          <line
            key={deg}
            x1="12"
            y1="3.2"
            x2="12"
            y2="5.2"
            stroke={accent}
            strokeWidth={1.6}
            strokeLinecap="round"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
      </svg>
    );
  }
  if (icon === "clear" && !isDay) {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <path d="M15.5 4.5a8 8 0 1 0 4 12.6 6.3 6.3 0 0 1-4-12.6Z" {...common} stroke={accent} />
      </svg>
    );
  }
  if (icon === "partly-cloudy") {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <circle cx="9" cy="9" r="3.4" {...common} stroke={accent} />
        <path d="M7 18h9.5a3.5 3.5 0 0 0 .3-7 4.6 4.6 0 0 0-8.8-1.3" {...common} />
      </svg>
    );
  }
  if (icon === "fog") {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <path d="M6 10h9a3.5 3.5 0 1 0-.9-6.9A5.5 5.5 0 0 0 4.3 8" {...common} />
        <line x1="4" y1="14" x2="20" y2="14" {...common} />
        <line x1="6" y1="17.5" x2="18" y2="17.5" {...common} />
        <line x1="8" y1="21" x2="16" y2="21" {...common} />
      </svg>
    );
  }
  if (icon === "drizzle" || icon === "rain") {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <path d="M6.5 13h10.2a3.8 3.8 0 0 0 .3-7.5A5 5 0 0 0 7.4 8.6a4 4 0 0 0-.9 7.9" {...common} />
        <line x1="8" y1="16" x2="7" y2="19.5" stroke={accent} strokeWidth={1.6} strokeLinecap="round" />
        <line x1="12" y1="16" x2="11" y2="19.5" stroke={accent} strokeWidth={1.6} strokeLinecap="round" />
        <line x1="16" y1="16" x2="15" y2="19.5" stroke={accent} strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "snow") {
    return (
      <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
        <path d="M6.5 13h10.2a3.8 3.8 0 0 0 .3-7.5A5 5 0 0 0 7.4 8.6a4 4 0 0 0-.9 7.9" {...common} />
        <g stroke={accent} strokeWidth={1.6} strokeLinecap="round">
          <line x1="8" y1="16.5" x2="8" y2="20" />
          <line x1="12" y1="16.5" x2="12" y2="20" />
          <line x1="16" y1="16.5" x2="16" y2="20" />
        </g>
      </svg>
    );
  }
  // thunderstorm
  return (
    <svg viewBox="0 0 24 24" className="weather-icon" aria-hidden>
      <path d="M6.5 12h10.2a3.8 3.8 0 0 0 .3-7.5A5 5 0 0 0 7.4 7.6a4 4 0 0 0-.9 7.9" {...common} />
      <path d="M13 13.5 10 18h3l-1.5 3.5 5-6h-3l1.5-2Z" fill={accent} stroke="none" />
    </svg>
  );
}

export default function WeatherPanel() {
  const { data, error, loading, refresh } = useWeather();

  return (
    <div className="panel panel-enter" style={{ position: "relative" }}>
      <div className="panel-title" style={{ marginBottom: 10 }}>
        <span className={`dot ${data ? "dot-live" : error ? "dot-fail" : "dot-idle"}`} aria-hidden />
        {data?.place ?? "Dallas, TX"} — Weather
      </div>

      {loading && !data && !error && (
        <div className="weather-panel">
          <div className="skeleton" style={{ width: 52, height: 52, borderRadius: 999 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ width: 90, height: 28, marginBottom: 8, borderRadius: 4 }} />
            <div className="skeleton" style={{ width: 140, height: 14, borderRadius: 4 }} />
          </div>
        </div>
      )}

      {error && !data && (
        <div className="empty">
          Weather is unavailable right now ({error}).{" "}
          <button className="btn btn-quiet" style={{ fontSize: 11 }} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {data && (
        <div className="weather-panel">
          <WeatherGlyph icon={data.icon} isDay={data.isDay} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="weather-temp mono">{data.tempF}°F</div>
            <div className="weather-cond">
              {data.condition} · feels {data.feelsLikeF}°
            </div>
            <div className="weather-hilo mono">
              <span className="text-warning">H {data.highF}°</span>
              <span className="text-muted">L {data.lowF}°</span>
            </div>
          </div>
          <div className="weather-extra">
            <div>
              <div className="label">Humidity</div>
              <div className="value">{data.humidity}%</div>
            </div>
            <div>
              <div className="label">Wind</div>
              <div className="value">{data.windMph} mph</div>
            </div>
          </div>
        </div>
      )}

      {data && (
        <div className="field-hint" style={{ marginTop: 10 }}>
          Open-Meteo · observed {relative(data.observedAt)}
        </div>
      )}
    </div>
  );
}
