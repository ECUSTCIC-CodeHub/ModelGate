import { encodingForModel, getEncoding } from "js-tiktoken";

let fallbackEncoding: ReturnType<typeof getEncoding> | null = null;
let o200kEncoding: ReturnType<typeof getEncoding> | null = null;

// o1/o3/o4 推理系模型用 o200k_base。js-tiktoken 的前缀表并不覆盖所有变体
// （如裸 o4 会抛 Unknown model），未命中时会退回 cl100k_base 而系统性低估 token 数。
function isOSeriesModel(model: string) {
  for (const prefix of ["o1", "o3", "o4"]) {
    if (!model.startsWith(prefix)) continue;
    const rest = model.slice(prefix.length);
    if (rest === "" || rest[0] === "-" || rest[0] === "." || (rest[0] >= "0" && rest[0] <= "9")) return true;
  }
  return false;
}

function getModelEncoding(model: string) {
  if (isOSeriesModel(model)) {
    if (!o200kEncoding) o200kEncoding = getEncoding("o200k_base");
    return o200kEncoding;
  }
  try {
    return encodingForModel(model as Parameters<typeof encodingForModel>[0]);
  } catch {
    if (!fallbackEncoding) {
      fallbackEncoding = getEncoding("cl100k_base");
    }
    return fallbackEncoding;
  }
}

export function countTextTokens(text: string, model: string) {
  if (!text) return 0;
  try {
    const encoding = getModelEncoding(model);
    return encoding.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
