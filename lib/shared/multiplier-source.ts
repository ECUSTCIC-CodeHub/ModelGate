// 生效倍率的来源描述，纯文案不依赖 React：渠道卡片、列表行、模型列表页共用同一套说法。
// 来源按维度说：模型档只填了 token 时，request 仍然是渠道档或基础倍率给的，笼统写「模型级」会指错地方。
export type MultiplierSource = {
  tokenFromModelSchedule: boolean;
  requestFromModelSchedule: boolean;
  // 该维度命中了分时档（不论来源层）。为假时该维度既不是模型档也不是渠道档给的，就是基础倍率。
  tokenScheduled: boolean;
  requestScheduled: boolean;
};

const MODEL_ONLY = "模型级分时档";
const CHANNEL_ONLY = "渠道级分时档";
const NO_SCHEDULE = "基础倍率";

function originOf(fromModelSchedule: boolean, scheduled: boolean): string {
  if (fromModelSchedule) return MODEL_ONLY;
  return scheduled ? CHANNEL_ONLY : NO_SCHEDULE;
}

// 单条渠道（一条模型映射）的来源，返回值是完整句子，调用点只做插值。
export function describeScheduleSource(source: MultiplierSource): string {
  const tokenOrigin = originOf(source.tokenFromModelSchedule, source.tokenScheduled);
  const requestOrigin = originOf(source.requestFromModelSchedule, source.requestScheduled);
  if (tokenOrigin === requestOrigin) return `两个维度都来自${tokenOrigin}`;
  return `Token 倍率来自${tokenOrigin}，请求倍率来自${requestOrigin}`;
}

// 模型列表的聚合倍率：一个 alias 可能挂多条渠道，而 tag 是跨渠道的聚合判定，
// 只能说「部分或全部」，不能套用单条渠道那句「两个维度都来自……」。
export function describeAggregatedScheduleSource(source: MultiplierSource): string {
  if (source.tokenFromModelSchedule && source.requestFromModelSchedule) {
    return "两个维度都有渠道由模型级分时档覆盖";
  }
  if (source.tokenFromModelSchedule || source.requestFromModelSchedule) {
    const token = source.tokenFromModelSchedule ? "有" : "没有";
    const request = source.requestFromModelSchedule ? "有" : "没有";
    return `Token 倍率${token}渠道由模型级分时档覆盖，请求倍率${request}渠道由模型级分时档覆盖`;
  }
  return "没有渠道由模型级分时档覆盖，倍率来自渠道级分时档或基础倍率";
}
