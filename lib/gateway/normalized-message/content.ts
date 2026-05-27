import type { NormalizedContentPart } from "@/lib/gateway/normalized-message/types";
import { asRecord } from "@/lib/gateway/normalized-message/utils";

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
      return [];
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
        source: {
          type: "url",
          url: part.image_url,
        },
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
