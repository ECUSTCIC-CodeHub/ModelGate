import type { GatewayProtocol } from "@/lib/gateway/protocols";
import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import type {
  IntermediateStreamEvent,
  IntermediateStreamResult,
  PassthroughEventTracker,
} from "@/lib/gateway/protocol-adapters/streaming/common";

export type StreamingProtocol = Exclude<GatewayProtocol, "embeddings" | "images" | "other">;

export type StreamDecoder = (upstream: ReadableStream<Uint8Array>) => IntermediateStreamResult;

export type StreamEncoder = (
  events: ReadableStream<IntermediateStreamEvent>,
  options?: ResponseAdapterOptions,
) => ReadableStream<Uint8Array>;

export type ProtocolStreamAdapter = {
  protocol: StreamingProtocol;
  decode: StreamDecoder;
  encode: StreamEncoder;
  trackPassthroughEvent: PassthroughEventTracker;
};
