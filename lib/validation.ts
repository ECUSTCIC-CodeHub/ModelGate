import type { ZodError } from "zod";

export function friendlyCredentialPayloadError(error: ZodError) {
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");

    if (field === "username") {
      return "用户名仅支持英文和数字，长度为 3-32 位。";
    }
    if (field === "password" || field === "new_password") {
      return "密码长度至少 8 位。";
    }
    if (field === "current_password") {
      return "请输入当前密码。";
    }
  }

  return "请求参数不正确，请检查后重试。";
}
