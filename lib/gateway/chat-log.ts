import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";

export type ChatLogInput = CreateLogInput;

export async function insertChatLog(input: ChatLogInput) {
  await createLog(input);
}
