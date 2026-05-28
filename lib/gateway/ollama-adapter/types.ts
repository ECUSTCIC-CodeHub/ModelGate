export type JsonRecord = Record<string, unknown>;

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ToolCallState = {
  id?: string;
  name: string;
  arguments: string;
};
