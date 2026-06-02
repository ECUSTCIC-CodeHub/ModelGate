import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

declare global {
  var __totpEncryptionKey__: string | undefined;
}

function resolveEncryptionKey(): Buffer {
  const envKey = process.env.TOTP_ENCRYPTION_KEY;
  if (envKey) return Buffer.from(envKey, "hex");
  if (!globalThis.__totpEncryptionKey__) {
    globalThis.__totpEncryptionKey__ = randomBytes(32).toString("hex");
  }
  return Buffer.from(globalThis.__totpEncryptionKey__, "hex");
}

const ENCRYPTION_KEY = resolveEncryptionKey();

export function encryptTotpSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptTotpSecret(ciphertext: string): string {
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}
