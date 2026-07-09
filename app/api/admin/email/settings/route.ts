export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/auth/guards";
import { jsonError, jsonOk } from "@/lib/core/http";
import { getEmailSettings, setEmailSettings } from "@/lib/core/email";

const schema = z.object({
  enabled: z.boolean(),
  subject_template: z.string().max(500),
  from_name: z.string().max(100),
  footer: z.string().max(2000),
  report_enabled: z.boolean().optional(),
  report_to: z.string().max(2000).optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;
  const settings = await getEmailSettings();
  return jsonOk({
    data: {
      enabled: settings.enabled,
      subject_template: settings.subjectTemplate,
      from_name: settings.fromName,
      footer: settings.footer,
      report_enabled: settings.reportEnabled,
      report_to: settings.reportTo,
    },
  });
}

export async function PUT(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const settings = await setEmailSettings({
    enabled: parsed.data.enabled,
    subjectTemplate: parsed.data.subject_template,
    fromName: parsed.data.from_name,
    footer: parsed.data.footer,
    reportEnabled: parsed.data.report_enabled,
    reportTo: parsed.data.report_to,
  });

  return jsonOk({
    message: "邮件设置已保存。",
    data: {
      enabled: settings.enabled,
      subject_template: settings.subjectTemplate,
      from_name: settings.fromName,
      footer: settings.footer,
      report_enabled: settings.reportEnabled,
      report_to: settings.reportTo,
    },
  });
}
