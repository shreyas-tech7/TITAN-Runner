/** The four Eclipse themes, how one is remembered, and the colors the browser bar takes. */

export const THEMES = ["eclipse", "light", "oled", "contrast"] as const;
export type ThemeName = (typeof THEMES)[number];

export const THEME_LABEL: Record<ThemeName, string> = { eclipse: "Eclipse", light: "Light", oled: "OLED black", contrast: "High contrast" };

/** The page color of each theme, for the browser's theme-color meta tag. The values match app/tokens.css bg-base. */
export const THEME_COLOR: Record<ThemeName, string> = { eclipse: "#0a0e15", light: "#f5f7fb", oled: "#000000", contrast: "#000000" };

export const THEME_KEY = "titan-runner:theme";

/** Fired on `window` after a theme changes, so a control that shows the theme can follow a change made elsewhere. */
export const THEME_EVENT = "titan-runner:theme-change";

export function normalizeTheme(v: unknown): ThemeName {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v) ? (v as ThemeName) : "eclipse";
}

/** Applies a theme to the page and remembers it. Safe when storage is blocked. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the theme still applies for this visit */
  }
}

export function currentTheme(): ThemeName {
  if (typeof document === "undefined") return "eclipse";
  return normalizeTheme(document.documentElement.getAttribute("data-theme"));
}
