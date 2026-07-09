const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function toShanghaiDatetime(date: Date): string {
  const parts = SHANGHAI_FORMATTER.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}.${ms}`;
}

export function toShanghaiDatetimeNoMs(date: Date): string {
  return toShanghaiDatetime(date).slice(0, 19);
}

export const toMysqlDatetime = toShanghaiDatetimeNoMs;
