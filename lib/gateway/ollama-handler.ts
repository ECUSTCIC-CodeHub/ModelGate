import { createHash } from "node:crypto";
import { handleGatewayProtocolRequest } from "@/lib/gateway/gateway-handler";
import { chatCompletionsGatewayAdapter } from "@/lib/gateway/protocol-adapters";
import { checkApiKeyAuth } from "@/lib/auth/api-key-auth";
import { listAccessibleModels } from "@/lib/gateway/model-access";
import {
  adaptChatCompletionToOllama,
  adaptChatCompletionToOllamaStreamText,
  adaptOllamaChatRequestBody,
  createChatCompletionToOllamaStream,
  isOllamaStreamRequested,
  ollamaErrorBody,
} from "@/lib/gateway/ollama-adapter";

type JsonRecord = Record<string, unknown>;

const FORWARDED_HEADERS = [
  "X-Quota-Limit-Requests-Remaining",
  "X-Quota-Limit-Tokens-Remaining",
  "X-Period-Quota-Requests-Remaining",
  "X-Period-Quota-Tokens-Remaining",
  "X-Period-Quota-Reset",
] as const;

const OLLAMA_COMPAT_VERSION = "0.6.4";
const OLLAMA_COMPAT_CONTEXT_LENGTH = 128 * 1024;
const OLLAMA_COMPAT_MAX_OUTPUT_TOKENS = 8 * 1024;

function responseHeaders(source: Response, contentType: string) {
  const headers = new Headers({ "content-type": contentType });
  for (const key of FORWARDED_HEADERS) {
    const value = source.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function normalizeModifiedAt(value: string | null) {
  if (!value) return new Date(0).toISOString();
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function modelDigest(alias: string) {
  return `sha256:${createHash("sha256").update(alias).digest("hex")}`;
}

function modelFamily(alias: string) {
  return alias.split(/[/:]/)[0]?.trim() || "modelgate";
}

function ollamaModelDetails(alias: string) {
  const family = modelFamily(alias);
  return {
    parent_model: "",
    format: "modelgate",
    family,
    families: [family],
    parameter_size: "",
    quantization_level: "",
  };
}

function ollamaModelInfo(alias: string) {
  const family = modelFamily(alias);
  return {
    "general.architecture": "modelgate",
    "general.file_type": 0,
    "general.parameter_count": 0,
    "general.quantization_version": 0,
    "general.context_length": OLLAMA_COMPAT_CONTEXT_LENGTH,
    "general.max_output_tokens": OLLAMA_COMPAT_MAX_OUTPUT_TOKENS,
    "modelgate.context_length": OLLAMA_COMPAT_CONTEXT_LENGTH,
    "modelgate.max_output_tokens": OLLAMA_COMPAT_MAX_OUTPUT_TOKENS,
    [`${family}.context_length`]: OLLAMA_COMPAT_CONTEXT_LENGTH,
  };
}

function findAccessibleModel(request: Request, model: string) {
  const authResult = checkApiKeyAuth(request);
  if (!authResult.ok) {
    return {
      ok: false as const,
      response: jsonResponse(
        { error: authResult.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。" },
        { status: 401 },
      ),
    };
  }

  const item = listAccessibleModels(authResult.context.user).find((row) => row.alias === model);
  if (!item) {
    return { ok: false as const, response: jsonResponse({ error: `模型 ${model} 不存在或无权访问。` }, { status: 404 }) };
  }

  return { ok: true as const, item };
}

function createJsonRequest(source: Request, body: JsonRecord) {
  const headers = new Headers(source.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  return new Request(source.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: source.signal,
  });
}

function getRequestedModel(body: JsonRecord) {
  return typeof body.model === "string" ? body.model : "";
}

export function handleOllamaTagsRequest(request: Request) {
  const authResult = checkApiKeyAuth(request);
  if (!authResult.ok) {
    return jsonResponse(
      { error: authResult.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。" },
      { status: 401 },
    );
  }

  const models = listAccessibleModels(authResult.context.user).map((item) => {
    return {
      name: item.alias,
      model: item.alias,
      modified_at: normalizeModifiedAt(item.created_at),
      size: 0,
      digest: modelDigest(item.alias),
      details: ollamaModelDetails(item.alias),
    };
  });

  return jsonResponse({ models });
}

async function parseOllamaShowModel(request: Request) {
  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return null;
  const body = rawBody as JsonRecord;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  return model || name || null;
}

export async function handleOllamaShowRequest(request: Request) {
  const model = await parseOllamaShowModel(request);
  if (!model) {
    return jsonResponse({ error: "请求参数不正确，缺少 model。" }, { status: 400 });
  }

  const result = findAccessibleModel(request, model);
  if (!result.ok) return result.response;

  const details = ollamaModelDetails(result.item.alias);
  return jsonResponse({
    license: "",
    modelfile: `FROM ${result.item.alias}`,
    parameters: `num_ctx ${OLLAMA_COMPAT_CONTEXT_LENGTH}\nnum_predict ${OLLAMA_COMPAT_MAX_OUTPUT_TOKENS}`,
    template: "",
    details,
    model_info: ollamaModelInfo(result.item.alias),
    capabilities: ["completion", "tools"],
    modified_at: normalizeModifiedAt(result.item.created_at),
  });
}

export function handleOllamaVersionRequest(request: Request) {
  const authResult = checkApiKeyAuth(request);
  if (!authResult.ok) {
    return jsonResponse(
      { error: authResult.reason === "missing" ? "认证失败，未提供 API Key。" : "认证失败，API Key 无效或已禁用。" },
      { status: 401 },
    );
  }

  return jsonResponse({ version: OLLAMA_COMPAT_VERSION });
}

export async function handleOllamaChatRequest(request: Request) {
  const startedAt = Date.now();
  const contentLength = parseInt(request.headers.get("content-length") || "0");
  if (contentLength > 10 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "请求体过大" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return new Response(JSON.stringify({ error: "请求参数不正确" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const body = rawBody as JsonRecord;
  const model = getRequestedModel(body);
  const stream = isOllamaStreamRequested(body);
  const gatewayRequest = createJsonRequest(request, adaptOllamaChatRequestBody(body));
  const gatewayResponse = await handleGatewayProtocolRequest(gatewayRequest, chatCompletionsGatewayAdapter);

  if (!gatewayResponse.ok) {
    const text = await gatewayResponse.text().catch(() => "");
    return new Response(ollamaErrorBody(text, gatewayResponse.status), {
      status: gatewayResponse.status,
      headers: responseHeaders(gatewayResponse, "application/json"),
    });
  }

  if (stream) {
    const contentType = gatewayResponse.headers.get("content-type") ?? "";
    if (gatewayResponse.body && contentType.includes("text/event-stream")) {
      return new Response(createChatCompletionToOllamaStream(gatewayResponse.body, model, startedAt), {
        status: gatewayResponse.status,
        headers: {
          ...Object.fromEntries(responseHeaders(gatewayResponse, "application/x-ndjson")),
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        },
      });
    }

    const text = await gatewayResponse.text();
    try {
      return new Response(adaptChatCompletionToOllamaStreamText(text, model, startedAt), {
        status: gatewayResponse.status,
        headers: responseHeaders(gatewayResponse, "application/x-ndjson"),
      });
    } catch {
      return new Response(JSON.stringify({ error: "响应格式转换失败" }), {
        status: 502,
        headers: responseHeaders(gatewayResponse, "application/json"),
      });
    }
  }

  const text = await gatewayResponse.text();
  try {
    return new Response(adaptChatCompletionToOllama(text, model, startedAt), {
      status: gatewayResponse.status,
      headers: responseHeaders(gatewayResponse, "application/json"),
    });
  } catch {
    return new Response(JSON.stringify({ error: "响应格式转换失败" }), {
      status: 502,
      headers: responseHeaders(gatewayResponse, "application/json"),
    });
  }
}
