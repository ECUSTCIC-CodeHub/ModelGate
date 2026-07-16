import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const integerFormatter = new Intl.NumberFormat("zh-CN");

export function formatNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return integerFormatter.format(value);
}

export function formatCompactNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const display = Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
  const abs = Math.abs(display);
  if (abs >= 1_000_000_000_000) return `${(display / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `${(display / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(display / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(display / 1_000).toFixed(2)}K`;
  return integerFormatter.format(display);
}

export function formatTokenCount(value: number | null | undefined) {
  return formatCompactNumber(value);
}

export function formatDatetime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export function formatAnnouncementDate(value: string, withTime = false) {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (!withTime) return `${y}-${m}-${d}`;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export const MARKDOWN_PURIFY_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "ul", "ol", "li", "a", "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "del", "s", "sub", "sup"],
  ALLOWED_ATTR: ["href", "title", "class"],
};

export const STATUS_LIGHT_MAX_HOURS = 168;

export function clampStatusLightHours(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.min(Math.trunc(num), STATUS_LIGHT_MAX_HOURS);
}
