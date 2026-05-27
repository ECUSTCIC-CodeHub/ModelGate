import { handleGatewayProtocolRequest } from "@/lib/gateway-handler";
import {
  adaptChatCompletionToOllama,
  adaptChatCompletionToOllamaStreamText,
  adaptOllamaChatRequestBody,
  createChatCompletionToOllamaStream,
  isOllamaStreamRequested,
  ollamaErrorBody,
} from "@/lib/ollama-adapter";

type JsonRecord = Record<string, unknown>;

const FORWARDED_HEADERS = [
  "X-Quota-Limit-Requests-Remaining",
  "X-Quota-Limit-Tokens-Remaining",
  "X-Period-Quota-Requests-Remaining",
  "X-Period-Quota-Tokens-Remaining",
  "X-Period-Quota-Reset",
] as const;

function responseHeaders(source: Response, contentType: string) {
  const headers = new Headers({ "content-type": contentType });
  for (const key of FORWARDED_HEADERS) {
    const value = source.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
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
  const gatewayResponse = await handleGatewayProtocolRequest(gatewayRequest, "chat_completions");

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
