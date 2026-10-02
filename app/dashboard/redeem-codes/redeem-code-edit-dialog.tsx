"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authedFetch } from "@/lib/auth/client-auth";
import type { CodeRow } from "./redeem-code-types";

// 把存储的 UTC 裸字符串转成 datetime-local 需要的本地时间字符串。
function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 用 key 重挂载来初始化表单，避免在 effect 里同步 setState。
export function RedeemCodeEditDialog({
  row,
  onClose,
  onSaved,
}: {
  row: CodeRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(row.note ?? "");
  const [expiresAt, setExpiresAt] = useState(toLocalInput(row.expires_at));
  const [maxUses, setMaxUses] = useState(row.max_uses);
  const [tokenQuota, setTokenQuota] = useState(row.token_quota === null ? "" : String(row.token_quota));
  const [requestQuota, setRequestQuota] = useState(row.request_quota === null ? "" : String(row.request_quota));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const payload: Record<string, unknown> = {};

    if (note.trim() !== (row.note ?? "")) payload.note = note.trim() ? note.trim() : null;
    if (maxUses !== row.max_uses) payload.max_uses = maxUses;
    if (expiresAt !== toLocalInput(row.expires_at)) payload.expires_at = expiresAt ? new Date(expiresAt).toISOString() : null;

    const tokenValue = tokenQuota.trim() ? Number(tokenQuota) : null;
    if (tokenValue !== row.token_quota) {
      if (tokenValue !== null && row.token_quota !== null && tokenValue < row.token_quota) {
        toast.error("Token 额度只能上调，不能下调");
        return;
      }
      payload.token_quota = tokenValue;
    }

    const requestValue = requestQuota.trim() ? Number(requestQuota) : null;
    if (requestValue !== row.request_quota) {
      if (requestValue !== null && row.request_quota !== null && requestValue < row.request_quota) {
        toast.error("请求额度只能上调，不能下调");
        return;
      }
      payload.request_quota = requestValue;
    }

    if (Object.keys(payload).length === 0) {
      toast.info("没有改动");
      return;
    }

    setSaving(true);
    try {
      const res = await authedFetch(`/api/admin/redeem-codes/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error?.message ?? "保存失败");
        return;
      }
      toast.success(data?.message ?? "已保存");
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑兑换码</DialogTitle>
          <DialogDescription>
            额度与有效期「只增不减」，别让已兑换的用户凭空失效。兑换码本身、批次与限定渠道/模型不可修改。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div className="rounded-xl border border-[var(--color-border)] p-3 text-sm">
            <span className="text-[var(--color-foreground-muted)]">兑换码：</span>
            <span className="font-mono">{row.code}</span>
          </div>
          <div>
            <Label>备注</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>有效期（只能延长）</Label>
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
            <div>
              <Label>最多兑换次数（0 表示不限，只能放宽）</Label>
              <Input type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
            </div>
            <div>
              <Label>Token 额度（留空表示不限，只能上调）</Label>
              <Input type="number" min={1} value={tokenQuota} onChange={(e) => setTokenQuota(e.target.value)} placeholder="不限" />
            </div>
            <div>
              <Label>请求额度（留空表示不限，只能上调）</Label>
              <Input type="number" min={1} value={requestQuota} onChange={(e) => setRequestQuota(e.target.value)} placeholder="不限" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
