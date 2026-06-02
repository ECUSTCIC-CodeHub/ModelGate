import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import type { GatewayProtocolAdapter } from "@/lib/gateway/protocol-adapters/runtime";
import {
  createPassthroughStream,
  type StreamTransformResult,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import { getStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/registry";

export function createTransformedStream(
  upstream: ReadableStream<Uint8Array>,
  outboundAdapter: GatewayProtocolAdapter,
  inboundAdapter: GatewayProtocolAdapter,
  options?: ResponseAdapterOptions,
): StreamTransformResult {
  const outboundProtocol = outboundAdapter.protocol;
  const inboundProtocol = inboundAdapter.protocol;
  if (outboundProtocol === inboundProtocol) {
    const passthroughAdapter = getStreamAdapter(outboundProtocol);
    return createPassthroughStream(upstream, passthroughAdapter?.trackPassthroughEvent ?? (() => null));
  }

  const outboundStreamAdapter = getStreamAdapter(outboundProtocol);
  const inboundStreamAdapter = getStreamAdapter(inboundProtocol);
  if (!outboundStreamAdapter || !inboundStreamAdapter) {
    throw new Error(`${outboundProtocol} 协议流不能转换为 ${inboundProtocol}`);
  }

  const decoded = outboundStreamAdapter.decode(upstream);
  return {
    stream: inboundStreamAdapter.encode(decoded.stream, options),
    completionText: decoded.completionText,
    firstTokenAt: decoded.firstTokenAt,
    usage: decoded.usage,
  };
}

export type { StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming/common";
