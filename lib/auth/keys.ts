import { randomBytes } from "node:crypto";

export function generateGatewayKey() {
  return `sk-gw-${randomBytes(18).toString("hex")}`;
}
