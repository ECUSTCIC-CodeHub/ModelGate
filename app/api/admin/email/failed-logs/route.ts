export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonOk } from "@/lib/core/http";
import { listEmailSendLogs } from "@/lib/core/email";

const schema = z.object({
  status: z.enum(["sent", "failed"]).optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const parsed = schema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) return jsonOk({ data: [] });

  const logs = await listEmailSendLogs(parsed.data.status);
  return jsonOk({ data: logs });
}
