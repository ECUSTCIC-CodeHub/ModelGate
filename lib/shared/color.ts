/**
 * 颜色工具函数：从单一主题色生成 CSS 变量
 */

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length !== 6) return null;
  const num = parseInt(cleaned, 16);
  if (Number.isNaN(num)) return null;
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function darkenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const newL = Math.max(0, hsl.l - amount);
  const result = hslToRgb(hsl.h, hsl.s, newL);
  return rgbToHex(result.r, result.g, result.b);
}

function contrastText(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? "#111827" : "#ffffff";
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export const THEME_PRESETS: { name: string; color: string }[] = [
  { name: "靛蓝", color: "#6366f1" },
  { name: "蓝色", color: "#3b82f6" },
  { name: "青色", color: "#06b6d4" },
  { name: "翠绿", color: "#10b981" },
  { name: "橙红", color: "#f97316" },
  { name: "玫红", color: "#f43f5e" },
  { name: "紫色", color: "#8b5cf6" },
  { name: "深蓝", color: "#00518f" },
];

/** 根据主题色生成 hover 色（HSL 明度 -0.12） */
export function getHoverColor(hex: string): string {
  return darkenHex(hex, 0.12);
}

/** 根据主题色生成淡背景色 */
export function getMutedColor(hex: string): string {
  return rgba(hex, 0.18);
}

/** 根据主题色生成前景色（自动选择黑/白） */
export function getContrastText(hex: string): string {
  return contrastText(hex);
}

export interface ThemeCssVariables {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** 根据主题色生成完整的 CSS 变量集合 */
export function generateThemeCssVariables(hex: string): ThemeCssVariables {
  const rgb = hexToRgb(hex);
  if (!rgb) return { light: {}, dark: {} };

  const { r, g, b } = rgb;
  const hsl = rgbToHsl(r, g, b);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  const lightHover = hslToRgb(hsl.h, hsl.s, Math.max(0, hsl.l - 0.12));
  const darkHover = hslToRgb(hsl.h, hsl.s, Math.min(1, hsl.l + 0.12));
  const lightHoverStr = `rgb(${lightHover.r}, ${lightHover.g}, ${lightHover.b})`;
  const darkHoverStr = `rgb(${darkHover.r}, ${darkHover.g}, ${darkHover.b})`;

  const lightFg = lum > 0.5 ? "#111827" : "#ffffff";
  const darkFg = lum > 0.5 ? "#0d1224" : "#f8fafc";

  const muted = `rgba(${r}, ${g}, ${b}, 0.18)`;
  const sidebarHover = `rgba(${r}, ${g}, ${b}, 0.14)`;
  const chartCursorFillLight = `rgba(${r}, ${g}, ${b}, 0.14)`;
  const chartCursorStrokeLight = `rgba(${r}, ${g}, ${b}, 0.3)`;
  const chartCursorFillDark = `rgba(${r}, ${g}, ${b}, 0.12)`;
  const chartCursorStrokeDark = `rgba(${r}, ${g}, ${b}, 0.28)`;

  return {
    light: {
      "--color-accent": hex,
      "--color-accent-hover": lightHoverStr,
      "--color-accent-foreground": lightFg,
      "--color-accent-muted": muted,
      "--color-sidebar-active-bg": hex,
      "--color-sidebar-active-text": lightFg,
      "--color-sidebar-hover": sidebarHover,
      "--color-chart-bar": hex,
      "--color-chart-cursor-fill": chartCursorFillLight,
      "--color-chart-cursor-stroke": chartCursorStrokeLight,
    },
    dark: {
      "--color-accent": hex,
      "--color-accent-hover": darkHoverStr,
      "--color-accent-foreground": darkFg,
      "--color-accent-muted": muted,
      "--color-sidebar-active-bg": hex,
      "--color-sidebar-active-text": darkFg,
      "--color-sidebar-hover": sidebarHover,
      "--color-chart-bar": hex,
      "--color-chart-cursor-fill": chartCursorFillDark,
      "--color-chart-cursor-stroke": chartCursorStrokeDark,
    },
  };
}

/** 将 CSS 变量对象转换为 CSS 文本 */
export function cssVariablesToText(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}
