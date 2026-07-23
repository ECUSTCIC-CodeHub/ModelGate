export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";

const PREFS_COOKIE_NAME = "modelgate-prefs";

const schema = z.object({
  appearance: z.enum(["default", "retro"]),
  mode: z.enum(["light", "dark", "system"]),
});

function parsePrefsCookie(cookieValue: string | undefined): { appearance: "default" | "retro"; mode: "light" | "dark" | "system" } | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(",");
  if (parts.length !== 2) return null;
  const [appearance, mode] = parts;
  if (appearance !== "default" && appearance !== "retro") return null;
  if (mode !== "light" && mode !== "dark" && mode !== "system") return null;
  return { appearance, mode };
}

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(new RegExp(`${PREFS_COOKIE_NAME}=([^;]+)`));
  const prefs = parsePrefsCookie(match?.[1]);

  return jsonOk({
    data: prefs ?? { appearance: "default", mode: "light" },
  });
}

export async function PUT(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const { appearance, mode } = parsed.data;
  const cookieValue = `${appearance},${mode}`;

  const response = jsonOk({ message: "主题偏好已保存" });
  response.cookies.set(PREFS_COOKIE_NAME, cookieValue, {
    httpOnly: false,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return response;
}