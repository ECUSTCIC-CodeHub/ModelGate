import { normalizeAnthropicMessages } from "@/lib/gateway/normalized-message";
import {
  type ProtocolBodyAdapter,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { createBodyProtocolGatewayAdapter, inputTextFromMessages } from "@/lib/gateway/protocol-adapters/runtime";
import {
  anthropicRequestFromIntermediate,
  anthropicRequestToIntermediate,
} from "@/lib/gateway/protocol-adapters/anthropic-request";
import {
  anthropicResponseFromIntermediate,
  anthropicResponseToIntermediate,
} from "@/lib/gateway/protocol-adapters/anthropic-response";

export const anthropicAdapter: ProtocolBodyAdapter = {
  requestToIntermediate: anthropicRequestToIntermediate,
  requestFromIntermediate: anthropicRequestFromIntermediate,
  responseToIntermediate: anthropicResponseToIntermediate,
  responseFromIntermediate: anthropicResponseFromIntermediate,
};

export const anthropicGatewayAdapter = createBodyProtocolGatewayAdapter({
  protocol: "anthropic_messages",
  bodyAdapter: anthropicAdapter,
  getInputText(body) {
    return inputTextFromMessages(normalizeAnthropicMessages(body.messages, body.system));
  },
  getMaxOutputTokens(body) {
    return body.max_tokens;
  },
});
