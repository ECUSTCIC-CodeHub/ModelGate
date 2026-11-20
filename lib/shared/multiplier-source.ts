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

// 一个 alias 挂多条渠道时的聚合来源。聚合值只代表「至少一条渠道命中模型档」，
// 所以不能说成两个维度都来自模型档，也不能说某维度「都没有」——要写清是「没有渠道命中」。
export function describeAggregatedScheduleSource(
  source: Pick<MultiplierSource, "tokenFromModelSchedule" | "requestFromModelSchedule">,
): string {
  const { tokenFromModelSchedule, requestFromModelSchedule } = source;
  if (tokenFromModelSchedule && requestFromModelSchedule) {
    return "两个维度都至少有一条渠道由模型级分时档覆盖";
  }
  if (tokenFromModelSchedule) {
    return "Token 倍率至少有一条渠道由模型级分时档覆盖，请求倍率没有任何渠道命中模型级分时档（来自渠道级分时档或基础倍率）";
  }
  if (requestFromModelSchedule) {
    return "请求倍率至少有一条渠道由模型级分时档覆盖，Token 倍率没有任何渠道命中模型级分时档（来自渠道级分时档或基础倍率）";
  }
  return "没有任何渠道命中模型级分时档，倍率来自渠道级分时档或基础倍率";
}
