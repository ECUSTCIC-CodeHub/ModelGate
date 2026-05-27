import { decodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-decode";
import { encodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-encode";
import {
  trackResponsesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/responses-events";
import type { ProtocolStreamAdapter } from "@/lib/gateway/protocol-adapters/streaming/types";

export { decodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-decode";
export { encodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-encode";
export {
  parseResponsesSseEvent,
  trackResponsesStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/responses-events";

export const responsesStreamAdapter: ProtocolStreamAdapter = {
  protocol: "responses",
  decode: decodeResponsesStream,
  encode: (events) => encodeResponsesStream(events),
  trackPassthroughEvent: trackResponsesStreamEvent,
};
