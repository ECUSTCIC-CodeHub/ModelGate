export function toMysqlDatetime(isoString: string): string {
  if (isoString.endsWith("Z")) return isoString.slice(0, -1);
  return isoString;
}
