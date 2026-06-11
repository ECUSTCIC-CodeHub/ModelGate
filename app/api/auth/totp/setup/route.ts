export const dynamic = "force-dynamic";

import QRCode from "qrcode";
import { ensureWebUser } from "@/lib/auth/guards";
import { jsonOk, jsonError } from "@/lib/core/http";
import { gatewayDb } from "@/lib/core/db";
import { generateTotpSecret, encryptAndEncodeSecret } from "@/lib/auth/totp";

export async function POST(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const user = guard.auth.user;

  const row = await gatewayDb
    .queryOne<{ totp_enabled: number }>("SELECT totp_enabled FROM users WHERE id = ? AND deleted_at IS NULL", [user.id]);

  if (row?.totp_enabled === 1) {
    return jsonError("TOTP 已启用，请先解绑再重新设置", 409);
  }

  const { secret, otpUri } = generateTotpSecret(user.username);
  const encrypted = encryptAndEncodeSecret(secret);

  await gatewayDb
    .execute("UPDATE users SET totp_secret = ? WHERE id = ?", [encrypted, user.id]);

  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(otpUri, { width: 256, margin: 2 });
  } catch {
    return jsonError("二维码生成失败", 500);
  }

  return jsonOk({
    secret,
    otp_uri: otpUri,
    qr_data_url: qrDataUrl,
  });
}
