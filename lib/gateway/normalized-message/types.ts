export type JsonRecord = Record<string, unknown>;

export type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string | null; redacted?: boolean }
  | { type: "image"; image_url: string; detail?: string | null }
  | { type: "file"; value: JsonRecord }
  | { type: "unknown"; value: unknown };

export type NormalizedMessage = {
  role: string;
  content: NormalizedContentPart[];
  tool_calls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  tool_call_id?: string;
};
