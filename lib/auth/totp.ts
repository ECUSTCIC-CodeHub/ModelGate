import { TOTP, Secret } from "otpauth";
import { encryptTotpSecret, decryptTotpSecret } from "@/lib/auth/totp-crypto";
import { isTotpCodeReplayed, markTotpCodeUsed } from "@/lib/auth/totp-replay";

const ISSUER = "ModelGate";
const PERIOD = 30;
const DIGITS = 6;

export function generateTotpSecret(username: string): { secret: string; otpUri: string } {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret,
  });
  return {
    secret: secret.base32,
    otpUri: totp.toString(),
  };
}

export function encryptAndEncodeSecret(plaintextSecret: string): string {
  return encryptTotpSecret(plaintextSecret);
}

export function verifyTotpCode(encryptedSecret: string, code: string, userId: number): boolean {
  if (isTotpCodeReplayed(userId, code)) return false;

  const plaintextSecret = decryptTotpSecret(encryptedSecret);
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(plaintextSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return false;

  markTotpCodeUsed(userId, code);
  return true;
}
