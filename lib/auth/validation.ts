import { z, type ZodError } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_LENGTH_MESSAGE = "密码长度需为 8-72 字节（UTF-8 编码，一个汉字约 3 字节）。";

// bcrypt 只使用前 72 字节，按字符数校验会让更长的密码被静默截断（不同密码可能等价），
// 因此这里按 UTF-8 字节长度校验。
export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export function passwordSchema() {
  return z
    .string()
    .min(PASSWORD_MIN_LENGTH, PASSWORD_LENGTH_MESSAGE)
    .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, PASSWORD_LENGTH_MESSAGE);
}

export function friendlyCredentialPayloadError(error: ZodError) {
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");

    if (field === "username") {
      return "用户名仅支持英文和数字，长度为 3-32 位。";
    }
    if (field === "password" || field === "new_password") {
      return PASSWORD_LENGTH_MESSAGE;
    }
    if (field === "current_password") {
      return "请输入当前密码。";
    }
  }

  return "请求参数不正确，请检查后重试。";
}
