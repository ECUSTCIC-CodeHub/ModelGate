import { decodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-decode";
import { encodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-encode";
import { trackResponsesStreamEvent, } from "@/lib/gateway/protocol-adapters/streaming/responses-events";
export { decodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-decode";
export { encodeResponsesStream } from "@/lib/gateway/protocol-adapters/streaming/responses-encode";
export { parseResponsesSseEvent, trackResponsesStreamEvent, } from "@/lib/gateway/protocol-adapters/streaming/responses-events";
export const responsesStreamAdapter = {
    protocol: "responses",
    decode: decodeResponsesStream,
    encode: (events, options) => encodeResponsesStream(events, options),
    trackPassthroughEvent: trackResponsesStreamEvent,
};
