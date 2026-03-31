export const GATEWAY_PROTOCOLS = ["chat_completions", "responses", "anthropic_messages"] as const;

export type GatewayProtocol = (typeof GATEWAY_PROTOCOLS)[number];

const DEFAULT_PROTOCOLS: GatewayProtocol[] = ["chat_completions"];

export function isGatewayProtocol(value: unknown): value is GatewayProtocol {
  return typeof value === "string" && GATEWAY_PROTOCOLS.includes(value as GatewayProtocol);
}

export function parseSupportedProtocols(raw: string | null | undefined): GatewayProtocol[] {
  if (!raw) return [...DEFAULT_PROTOCOLS];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_PROTOCOLS];

    const normalized = parsed.filter(isGatewayProtocol);
    return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_PROTOCOLS];
  } catch {
    return [...DEFAULT_PROTOCOLS];
  }
}

export function stringifySupportedProtocols(protocols: GatewayProtocol[]) {
  const normalized = [...new Set(protocols.filter(isGatewayProtocol))];
  return JSON.stringify(normalized.length > 0 ? normalized : DEFAULT_PROTOCOLS);
}

export function normalizeSupportedProtocols(value: unknown): GatewayProtocol[] {
  if (!Array.isArray(value)) return [...DEFAULT_PROTOCOLS];
  const normalized = value.filter(isGatewayProtocol);
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_PROTOCOLS];
}

export function supportsProtocol(raw: string | null | undefined, protocol: GatewayProtocol) {
  return parseSupportedProtocols(raw).includes(protocol);
}
