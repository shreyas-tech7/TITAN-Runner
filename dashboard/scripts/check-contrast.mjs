#!/usr/bin/env node
/**
 * @file Eclipse contrast test. The authority on every token pairing.
 *
 * Reads app/tokens.css, resolves each of the four themes (eclipse, light, oled,
 * contrast), and checks:
 *
 *   - text.hi, text.body, text.dim against every surface: 4.5:1
 *   - each accent and status color used as text against every surface: 4.5:1
 *   - on-accent text on a solid accent button: 4.5:1
 *   - accent text on its own soft tint over surface.1 and surface.2: 4.5:1
 *   - line.control (input, checkbox, switch borders) against surfaces: 3:1
 *   - the ion focus ring against every surface: 3:1
 *   - every `text-<token>/NN` opacity variant found in components/ and app/,
 *     blended over each surface: 4.5:1
 *
 * text.faint is disabled and decoration only, so it is reported and never
 * gates. Exit 1 on any failure. A failing pair gets its lightness adjusted with
 * the hue kept, and the change is logged in docs/DESIGN_SYSTEM.md.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKENS = path.join(ROOT, "app", "tokens.css");

const THEMES = ["eclipse", "light", "oled", "contrast"];
const SURFACES = ["bg-void", "bg-base", "surface-1", "surface-2", "surface-3"];
const TEXT = ["text-hi", "text-body", "text-dim"];
const ACCENTS = ["ion", "plasma", "corona", "ok", "warn", "danger"];

/* ---- color math -------------------------------------------------------- */

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(fg, bg, alpha) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

/* ---- token parsing ----------------------------------------------------- */

function parseBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const vars = {};
    for (const decl of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1].slice(2)] = decl[2].trim();
    out.push({ selector, vars });
  }
  return out;
}

function resolveThemes(css) {
  const blocks = parseBlocks(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const base = {};
  const perTheme = {};
  for (const { selector, vars } of blocks) {
    if (selector.includes(':root[data-theme="eclipse"]') || /^:root(\s*,|$)/.test(selector)) Object.assign(base, vars);
    for (const t of THEMES) {
      if (selector === `:root[data-theme="${t}"]`) perTheme[t] = { ...(perTheme[t] ?? {}), ...vars };
    }
  }
  const themes = {};
  for (const t of THEMES) themes[t] = t === "eclipse" ? { ...base } : { ...base, ...(perTheme[t] ?? {}) };
  return themes;
}

function color(theme, name, depth = 0) {
  const raw = theme[name];
  if (raw === undefined) throw new Error(`token --${name} missing`);
  const v = raw.match(/^var\(--([\w-]+)\)$/);
  if (v && depth < 5) return color(theme, v[1], depth + 1);
  if (!/^#[0-9a-f]{3,6}$/i.test(raw)) throw new Error(`token --${name} is not a hex color: ${raw}`);
  return hexToRgb(raw);
}

/* ---- checks ------------------------------------------------------------ */

const css = readFileSync(TOKENS, "utf8");
const themes = resolveThemes(css);
const failures = [];
const notes = [];
let checked = 0;

function check(label, fg, bg, min) {
  checked += 1;
  const r = ratio(fg, bg);
  if (r + 1e-9 < min) failures.push(`${label}: ${r.toFixed(2)} (needs ${min})`);
  return r;
}

for (const t of THEMES) {
  const th = themes[t];
  const soft = Number.parseFloat(th["soft-alpha"] ?? "14") / 100;
  for (const s of SURFACES) {
    const bg = color(th, s);
    for (const n of TEXT) check(`${t}: ${n} on ${s}`, color(th, n), bg, 4.5);
    for (const a of ACCENTS) check(`${t}: ${a} text on ${s}`, color(th, a), bg, 4.5);
    check(`${t}: focus ring (ion) on ${s}`, color(th, "ion"), bg, 3);
  }
  for (const a of ACCENTS) {
    check(`${t}: on-accent text on solid ${a}`, color(th, "on-accent"), color(th, a), 4.5);
    for (const s of ["surface-1", "surface-2"]) {
      const tint = blend(color(th, a), color(th, s), soft);
      check(`${t}: ${a} text on its soft tint over ${s}`, color(th, a), tint, 4.5);
    }
  }
  for (const s of ["bg-base", "surface-1", "surface-2"]) {
    check(`${t}: line-control on ${s}`, color(th, "line-control"), color(th, s), 3);
  }
  // Chart colors are never the only carrier of meaning, but they still need to
  // be visible against the card they sit on.
  for (let i = 1; i <= 8; i += 1) check(`${t}: chart-${i} on surface-1`, color(th, `chart-${i}`), color(th, "surface-1"), 3);
  const faint = ratio(color(th, "text-faint"), color(th, "surface-1"));
  notes.push(`${t}: text-faint on surface-1 is ${faint.toFixed(2)} (decoration and disabled only, not gated)`);
}

/* ---- opacity variants in source ---------------------------------------- */

const TEXT_TOKENS = {
  hi: "text-hi",
  body: "text-body",
  dim: "text-dim",
  ion: "ion",
  plasma: "plasma",
  corona: "corona",
  ok: "ok",
  warn: "warn",
  danger: "danger",
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

const variants = new Map();
for (const dir of ["components", "app"]) {
  for (const file of walk(path.join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?<![\w-])text-(hi|body|dim|ion|plasma|corona|ok|warn|danger)\/(\d{1,3})\b/g)) {
      const key = `${m[1]}/${m[2]}`;
      const files = variants.get(key) ?? new Set();
      files.add(path.relative(ROOT, file));
      variants.set(key, files);
    }
  }
}

for (const t of THEMES) {
  const th = themes[t];
  for (const [key, files] of variants) {
    const [name, pct] = key.split("/");
    const fg = color(th, TEXT_TOKENS[name]);
    for (const s of ["bg-base", "surface-1", "surface-2"]) {
      const bg = color(th, s);
      const r = check(`${t}: text-${name}/${pct} on ${s} (${[...files][0]}${files.size > 1 ? ` +${files.size - 1}` : ""})`, blend(fg, bg, Number(pct) / 100), bg, 4.5);
      void r;
    }
  }
}

/* ---- report ------------------------------------------------------------ */

for (const n of notes) console.log(`note  ${n}`);
if (failures.length > 0) {
  console.log(`\ncheck:contrast FAILED, ${failures.length} of ${checked} pairs`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`check:contrast ok, ${checked} pairs across ${THEMES.length} themes, ${variants.size} opacity variants`);
