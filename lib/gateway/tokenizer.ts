import { getEncoding, getEncodingNameForModel } from "js-tiktoken";
import type { Tiktoken, TiktokenEncoding, TiktokenModel } from "js-tiktoken";

// js-tiktoken 的 getEncoding/encodingForModel 每次调用都会重新解析词表并重建 rank 表，
// 单次在 cl100k_base 上约 300ms、o200k_base 上约 700ms，且全是同步 CPU 计算。
// 每次请求要数 prompt、completion、reasoning 三处 token，逐次新建编码器会把这些
// 同步耗时空转成事件循环阻塞（实测单请求可达 2s），必须按编码族缓存复用。
// 键是编码族名而不是模型名，条目上限就是 JsTiktoken 支持的 6 种编码；
// 常用只有 cl100k_base(55MB) 与 o200k_base(118MB)，与改造前两个模块级单例的内存占用相同。
const encoders = new Map<TiktokenEncoding, Tiktoken>();

const FALLBACK_ENCODING: TiktokenEncoding = "cl100k_base";
const O_SERIES_ENCODING: TiktokenEncoding = "o200k_base";

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

function getEncoder(encoding: TiktokenEncoding): Tiktoken {
  let encoder = encoders.get(encoding);
  if (!encoder) {
    encoder = getEncoding(encoding);
    encoders.set(encoding, encoder);
  }
  return encoder;
}

function encodingForModelName(model: string): TiktokenEncoding {
  if (isOSeriesModel(model)) return O_SERIES_ENCODING;
  try {
    return getEncodingNameForModel(model as TiktokenModel);
  } catch {
    // 非 OpenAI 模型（claude、deepseek 等）不在 js-tiktoken 的表里，
    // 退回 cl100k_base 作为估算口径
    return FALLBACK_ENCODING;
  }
}

export function countTextTokens(text: string, model: string) {
  if (!text) return 0;
  try {
    return getEncoder(encodingForModelName(model)).encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
