"use client";

import { useEffect, useState } from "react";
import { THEMES, THEME_EVENT, THEME_LABEL, applyTheme, currentTheme } from "@/lib/theme";
import type { ThemeName } from "@/lib/theme";

/** A small select for the four themes. It reads the theme the boot script already set, then follows the choice. */
export default function ThemeSwitch() {
  const [theme, setTheme] = useState<ThemeName>("eclipse");
  useEffect(() => {
    setTheme(currentTheme());
    const follow = () => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, follow);
    return () => window.removeEventListener(THEME_EVENT, follow);
  }, []);
  return (
    <label className="theme-switch">
      <span className="sr-only">Theme</span>
      <select
        aria-label="Theme"
        value={theme}
        onChange={(e) => {
          const next = e.target.value as ThemeName;
          setTheme(next);
          applyTheme(next);
        }}
      >
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {THEME_LABEL[t]}
          </option>
        ))}
      </select>
    </label>
  );
}
