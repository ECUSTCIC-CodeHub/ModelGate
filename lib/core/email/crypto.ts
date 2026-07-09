import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const MARKER = "mg-enc:";

function getKey(): Buffer | null {
  const secret = process.env.EMAIL_ENCRYPTION_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!secret) return null;
  return createHash("sha256").update(secret, "utf8").digest();
}

let warnedNoSecret = false;
let warnedDecryptFail = false;

export function encryptPassword(plain: string): string {
  if (!plain) return "";
  const key = getKey();
  if (!key) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn("[ModelGate] 未配置 EMAIL_ENCRYPTION_SECRET 或 JWT_ACCESS_SECRET，SMTP 密码将以明文存储。");
    }
    return plain;
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptPassword(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(MARKER)) return stored;
  const key = getKey();
  if (!key) return "";
  try {
    const raw = Buffer.from(stored.slice(MARKER.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    if (!warnedDecryptFail) {
      warnedDecryptFail = true;
      console.warn("[ModelGate] 邮件发件账号密码解密失败，可能由于加密密钥（EMAIL_ENCRYPTION_SECRET/JWT_ACCESS_SECRET）已变更，请在邮件通知设置中重新保存相关账号密码。");
    }
    return "";
  }
}
