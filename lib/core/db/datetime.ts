function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toShanghaiDatetime(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}.${String(shifted.getUTCMilliseconds()).padStart(3, "0")}`;
}

export function toShanghaiDatetimeNoMs(date: Date): string {
  return toShanghaiDatetime(date).slice(0, 19);
}

export const toMysqlDatetime = toShanghaiDatetime;
export const toMysqlDatetimeNoMs = toShanghaiDatetimeNoMs;
