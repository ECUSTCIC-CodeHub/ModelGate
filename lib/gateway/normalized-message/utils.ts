import type { JsonRecord } from "@/lib/gateway/normalized-message/types";

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}
