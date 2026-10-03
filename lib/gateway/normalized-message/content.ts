import type { NormalizedContentPart } from "@/lib/gateway/normalized-message/types";
import { asRecord } from "@/lib/gateway/normalized-message/utils";

const DEFAULT_IMAGE_MEDIA_TYPE = "image/png";

// Anthropic 的图片是 {type:"image", source:{type:"base64"|"url", ...}}，
// 中间协议只保留一个 URL 字符串，故 base64 统一落成 data URL，与其他协议一致。
function anthropicImageUrl(record: Record<string, unknown>): string | null {
  const source = asRecord(record.source);
  if (!source) return null;
  const sourceType = typeof source.type === "string" ? source.type : "";

  const url = typeof source.url === "string" ? source.url : "";
  if (sourceType === "url" || (sourceType === "" && url)) {
    return url || null;
  }

  const data = typeof source.data === "string" ? source.data : "";
  if (sourceType !== "base64" && !(sourceType === "" && data)) return null;
  if (!data) return null;
  if (data.startsWith("data:")) return data;
  const mediaType = typeof source.media_type === "string" && source.media_type ? source.media_type : DEFAULT_IMAGE_MEDIA_TYPE;
  return `data:${mediaType};base64,${data}`;
}

// 反向：Anthropic 只接受 base64 或 url 两种 source，data URL 必须拆回 base64。
// 不用正则是为了让 base64 里可能出现的换行也能原样保留。
export function anthropicImageSource(imageUrl: string) {
  if (imageUrl.startsWith("data:")) {
    const commaIndex = imageUrl.indexOf(",");
    const header = commaIndex === -1 ? "" : imageUrl.slice("data:".length, commaIndex);
    if (commaIndex !== -1 && header.endsWith(";base64")) {
      return {
        type: "base64",
        media_type: header.slice(0, -";base64".length) || DEFAULT_IMAGE_MEDIA_TYPE,
        data: imageUrl.slice(commaIndex + 1),
      };
    }
  }
  return { type: "url", url: imageUrl };
}

export function normalizeContentParts(value: unknown): NormalizedContentPart[] {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "text", text: value }] : [];
  }

  if (!Array.isArray(value)) return [];

  const parts: NormalizedContentPart[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;

    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) parts.push({ type: "text", text });
      continue;
    }

    if (type === "thinking") {
      const thinking = typeof record.thinking === "string" ? record.thinking : typeof record.text === "string" ? record.text : "";
      if (thinking) {
        parts.push({
          type: "thinking",
          thinking,
          signature: typeof record.signature === "string" ? record.signature : null,
        });
      }
      continue;
    }

    if (type === "redacted_thinking") {
      parts.push({
        type: "thinking",
        thinking: typeof record.data === "string" ? record.data : "[redacted thinking]",
        signature: typeof record.signature === "string" ? record.signature : null,
        redacted: true,
      });
      continue;
    }

    if (type === "reasoning_text") {
      const thinking = typeof record.text === "string" ? record.text : "";
      if (thinking) parts.push({ type: "thinking", thinking });
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      const imageUrl = typeof record.image_url === "string"
        ? record.image_url
        : asRecord(record.image_url)?.url;
      if (typeof imageUrl === "string" && imageUrl.length > 0) {
        const detail = typeof record.detail === "string" ? record.detail : null;
        parts.push({ type: "image", image_url: imageUrl, detail });
      }
      continue;
    }

    if (type === "image") {
      const imageUrl = anthropicImageUrl(record);
      if (imageUrl) parts.push({ type: "image", image_url: imageUrl, detail: null });
      continue;
    }

    if (type === "file" || type === "input_file") {
      parts.push({ type: "file", value: record });
      continue;
    }

    if (typeof record.text === "string" && record.text.length > 0) {
      parts.push({ type: "text", text: record.text });
      continue;
    }

    parts.push({ type: "unknown", value: item });
  }

  return parts;
}

export function normalizedPartsToChatContent(parts: NormalizedContentPart[], options?: { preserveThinking?: boolean }) {
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "thinking") {
      if (options?.preserveThinking) {
        return part.redacted
          ? [{ type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }]
          : [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined }];
      }
      return [];
    }
    if (part.type === "image") {
      return [{ type: "image_url", image_url: { url: part.image_url, detail: part.detail ?? undefined } }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });

  if (normalized.length === 0) return "";
  if (normalized.length === 1 && normalized[0]?.type === "text") {
    return normalized[0].text;
  }
  return normalized;
}

export function normalizedPartsToResponseContent(parts: NormalizedContentPart[], role = "user") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: textType, text: part.text }];
    }
    if (part.type === "thinking") {
      return [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? null, redacted: part.redacted ?? false }];
    }
    if (part.type === "image") {
      return [{ type: "input_image", image_url: part.image_url, detail: part.detail ?? undefined }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });

  return normalized.length > 0 ? normalized : [{ type: textType, text: "" }];
}

export function normalizedPartsToAnthropicContent(parts: NormalizedContentPart[]) {
  return parts.flatMap((part) => {
    if (part.type === "text") {
      return part.text ? [{ type: "text", text: part.text }] : [];
    }
    if (part.type === "thinking") {
      return part.redacted
        ? [{ type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }]
        : [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined }];
    }
    if (part.type === "image") {
      return [{
        type: "image",
        source: anthropicImageSource(part.image_url),
      }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });
}

export function extractThinkingText(parts: NormalizedContentPart[]) {
  return parts
    .filter((part): part is Extract<NormalizedContentPart, { type: "thinking" }> => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}
