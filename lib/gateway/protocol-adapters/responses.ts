import { normalizeResponsesInput } from "@/lib/gateway/normalized-message";
import {
  type ProtocolBodyAdapter,
} from "@/lib/gateway/protocol-adapters/intermediate";
import { createBodyProtocolGatewayAdapter, inputTextFromMessages } from "@/lib/gateway/protocol-adapters/runtime";
import {
  responsesRequestFromIntermediate,
  responsesRequestToIntermediate,
} from "@/lib/gateway/protocol-adapters/responses-request";
import {
  responsesResponseFromIntermediate,
  responsesResponseToIntermediate,
} from "@/lib/gateway/protocol-adapters/responses-response";

export { extractResponsesMessage } from "@/lib/gateway/protocol-adapters/responses-response";

export const responsesAdapter: ProtocolBodyAdapter = {
  requestToIntermediate: responsesRequestToIntermediate,
  requestFromIntermediate: responsesRequestFromIntermediate,
  responseToIntermediate: responsesResponseToIntermediate,
  responseFromIntermediate: responsesResponseFromIntermediate,
};

export const responsesGatewayAdapter = createBodyProtocolGatewayAdapter({
  protocol: "responses",
  bodyAdapter: responsesAdapter,
  getInputText(body) {
    return inputTextFromMessages(
      normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined),
    );
  },
  getMaxOutputTokens(body) {
    return body.max_output_tokens;
  },
});
