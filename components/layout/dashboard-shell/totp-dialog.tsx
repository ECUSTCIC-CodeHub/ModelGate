"use client";

import Image from "next/image";
import { useState } from "react";
import { TotpCodeInput } from "@/components/auth/totp-code-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { authedFetch } from "@/lib/auth/client-auth";
import { getApiMessage } from "@/lib/shared/api-message";

type TotpSetupStep = "idle" | "setup" | "verify";

type TotpDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totpEnabled: boolean;
  passwordLoginEnabled: boolean;
  onStatusChange: () => void;
};

export function TotpDialog({
  open,
  onOpenChange,
  totpEnabled,
  passwordLoginEnabled,
  onStatusChange,
}: TotpDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<TotpSetupStep>("idle");
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [otpUri, setOtpUri] = useState("");
  const [code, setCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  function reset() {
    setStep("idle");
    setQrDataUrl("");
    setSecret("");
    setOtpUri("");
    setCode("");
    setDisablePassword("");
    setDisableCode("");
    setLoading(false);
  }

  async function onSetup() {
    setLoading(true);
    try {
      const response = await authedFetch("/api/auth/totp/setup", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "TOTP 设置失败。") });
        return;
      }
      setQrDataUrl(data.qr_data_url);
      setSecret(data.secret);
      setOtpUri(data.otp_uri);
      setStep("setup");
    } finally {
      setLoading(false);
    }
  }

  async function onVerifySetup() {
    if (code.length !== 6) {
      toast({ variant: "error", description: "请输入 6 位验证码。" });
      return;
    }
    setLoading(true);
    try {
      const response = await authedFetch("/api/auth/totp/verify-setup", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "验证码错误。") });
        return;
      }
      toast({ variant: "success", description: "TOTP 绑定成功。" });
      onStatusChange();
      reset();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }

  async function onDisable() {
    if (passwordLoginEnabled && !disablePassword) {
      toast({ variant: "error", description: "请输入当前密码。" });
      return;
    }
    if (!passwordLoginEnabled && disableCode.length !== 6) {
      toast({ variant: "error", description: "请输入 6 位验证码。" });
      return;
    }
    setLoading(true);
    try {
      const response = await authedFetch("/api/auth/totp/disable", {
        method: "POST",
        body: JSON.stringify(passwordLoginEnabled ? { password: disablePassword } : { code: disableCode }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ variant: "error", description: getApiMessage(data, "解绑失败。") });
        return;
      }
      toast({ variant: "success", description: "TOTP 已解绑。" });
      onStatusChange();
      reset();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {totpEnabled ? (
          <>
            <DialogHeader>
              <DialogTitle>关闭 2FA</DialogTitle>
              <DialogDescription>
                {passwordLoginEnabled
                  ? "输入当前密码后关闭登录验证码。"
                  : "输入当前验证码后关闭 2FA。"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {passwordLoginEnabled ? (
                <div className="space-y-2">
                  <Label htmlFor="totp_disable_password">当前密码</Label>
                  <Input
                    id="totp_disable_password"
                    type="password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="totp_disable_code">当前验证码</Label>
                  <TotpCodeInput
                    id="totp_disable_code"
                    value={disableCode}
                    onChange={setDisableCode}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
              <Button
                variant="destructive"
                onClick={onDisable}
                disabled={loading || (passwordLoginEnabled ? !disablePassword : disableCode.length !== 6)}
              >
                {loading ? "关闭中..." : "关闭"}
              </Button>
            </DialogFooter>
          </>
        ) : step === "idle" ? (
          <>
            <DialogHeader>
              <DialogTitle>启用 2FA</DialogTitle>
              <DialogDescription>绑定验证器后，登录需输入动态验证码。</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
              <Button onClick={onSetup} disabled={loading}>
                {loading ? "生成中..." : "开始设置"}
              </Button>
            </DialogFooter>
          </>
        ) : step === "setup" ? (
          <>
            <DialogHeader>
              <DialogTitle>扫描二维码</DialogTitle>
              <DialogDescription>用验证器扫描二维码，或手动输入密钥。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4">
              {qrDataUrl ? (
                <Image
                  src={qrDataUrl}
                  alt="TOTP QR Code"
                  width={208}
                  height={208}
                  unoptimized
                  className="h-52 w-52 rounded-lg border border-[var(--color-border)]"
                />
              ) : null}
              <div className="w-full space-y-2">
                <Label>手动输入密钥</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm break-all select-all">
                    {secret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(otpUri || secret);
                      toast({ variant: "success", description: "已复制到剪贴板。" });
                    }}
                  >
                    复制
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { reset(); handleOpenChange(false); }}>取消</Button>
              <Button onClick={() => setStep("verify")}>下一步</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>验证 2FA</DialogTitle>
              <DialogDescription>输入验证器中的 6 位验证码。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="totp_verify_code">验证码</Label>
                <TotpCodeInput
                  id="totp_verify_code"
                  value={code}
                  onChange={setCode}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("setup")}>上一步</Button>
              <Button onClick={onVerifySetup} disabled={loading || code.length !== 6}>
                {loading ? "验证中..." : "启用"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
