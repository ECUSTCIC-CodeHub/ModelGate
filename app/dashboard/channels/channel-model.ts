export type Protocol = "chat_completions" | "responses" | "anthropic_messages" | "embeddings";

export const protocolOptions: Array<{ value: Protocol; label: string; shortLabel: string }> = [
  { value: "chat_completions", label: "Chat Completions", shortLabel: "Chat" },
  { value: "responses", label: "Responses", shortLabel: "Responses" },
  { value: "anthropic_messages", label: "Claude Messages", shortLabel: "Claude" },
  { value: "embeddings", label: "Embeddings", shortLabel: "Embeddings" },
];

export function isProtocol(value: unknown): value is Protocol {
  return value === "chat_completions" || value === "responses" || value === "anthropic_messages" || value === "embeddings";
}

export function protocolLabel(protocol: Protocol) {
  return protocolOptions.find((option) => option.value === protocol)?.label ?? "Chat Completions";
}

export function shortProtocolLabel(protocol: Protocol) {
  return protocolOptions.find((option) => option.value === protocol)?.shortLabel ?? "Chat";
}

export function parseSupportedProtocols(raw: string | null | undefined): Protocol[] {
  if (!raw) return ["chat_completions"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = Array.isArray(parsed) ? parsed.filter(isProtocol) : [];
    return normalized.length > 0 ? normalized : ["chat_completions"];
  } catch {
    return ["chat_completions"];
  }
}

export type ModelRow = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  is_public: number;
  enabled: number;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
};

export type Channel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  user_agent: string;
  enabled: number;
  weight: number;
  max_concurrency: number;
  timeout: number;
  models?: ModelRow[];
};

export type ChannelModelDraft = {
  alias: string;
  real_model: string;
  upstream_protocol: Protocol;
  is_public: boolean;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  enabled: boolean;
};

export type ChannelForm = {
  name: string;
  base_url: string;
  api_key: string;
  user_agent: string;
  supported_protocols: Protocol[];
  weight: number;
  max_concurrency: number;
  timeout: number;
};

export type ModelForm = {
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: Protocol;
  is_public: boolean;
  weight: number;
  token_multiplier: number;
  request_multiplier: number;
  max_concurrency: number;
  enabled: boolean;
};

export type UpstreamModelOption = {
  id: string;
  selected: boolean;
  disabled: boolean;
};

export type ModelWithChannel = ModelRow & {
  channel_name: string;
};

export const initialChannelForm: ChannelForm = {
  name: "",
  base_url: "",
  api_key: "",
  user_agent: "",
  supported_protocols: ["chat_completions"],
  weight: 1,
  max_concurrency: 64,
  timeout: 60,
};

export const initialModelDraft: ChannelModelDraft = {
  alias: "",
  real_model: "",
  upstream_protocol: "chat_completions",
  is_public: true,
  weight: 1,
  token_multiplier: 1,
  request_multiplier: 1,
  max_concurrency: 0,
  enabled: true,
};

export const initialModelForm: ModelForm = {
  alias: "",
  real_model: "",
  channel_id: 0,
  upstream_protocol: "chat_completions",
  is_public: true,
  weight: 1,
  token_multiplier: 1,
  request_multiplier: 1,
  max_concurrency: 0,
  enabled: true,
};
