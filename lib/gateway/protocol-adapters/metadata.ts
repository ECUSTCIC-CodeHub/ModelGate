import { asRecord } from "@/lib/gateway/normalized-message";

const MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 512;

// OpenAI 的 metadata 只接受字符串键值对（最多 16 对、键不超过 64 字符、值不超过 512 字符），
// 且必须与 store: true 同时出现；客户端显式 store: false 表示不落库，metadata 无处附着，一并整体不下发
export function metadataForOpenAiUpstream(metadata: unknown, requestedStore?: unknown) {
  if (requestedStore === false) return undefined;
  const record = asRecord(metadata);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length === 0 || entries.length > MAX_METADATA_ENTRIES) return undefined;
  const withinLimits = entries.every(([key, value]) =>
    typeof value === "string"
    && [...key].length <= MAX_METADATA_KEY_LENGTH
    && [...value].length <= MAX_METADATA_VALUE_LENGTH);
  return withinLimits ? Object.fromEntries(entries) : undefined;
}
