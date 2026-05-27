import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";

export type ChatLogInput = CreateLogInput;

export function insertChatLog(input: ChatLogInput) {
  createLog(input);
}
