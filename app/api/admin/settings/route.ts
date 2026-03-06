import { z } from "zod";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { getGatewaySettings, setGatewaySettings } from "@/lib/settings";

const schema = z.object({
  registration_enabled: z.boolean(),
  default_qps: z.number().int().min(-1),
  default_rpm: z.number().int().min(-1),
  default_tpm: z.number().int().min(-1),
  upstream_retry_enabled: z.boolean(),
  upstream_retry_max_attempts: z.number().int().min(1).max(10),
});

export async function GET(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  return jsonOk({ message: "系统设置获取成功。", data: getGatewaySettings() });
}

export async function PUT(request: Request) {
  const guard = ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  setGatewaySettings(parsed.data);
  return jsonOk({ message: "系统设置更新成功。", data: getGatewaySettings() });
}
