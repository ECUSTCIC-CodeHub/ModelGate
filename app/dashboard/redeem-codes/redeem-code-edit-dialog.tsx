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

// 输入框里的额度：空串代表「不限」，其余按整数解析；非法输入返回 undefined。
function parseQuota(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
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
  const [maxUsesInput, setMaxUsesInput] = useState(String(row.max_uses));
  const [tokenQuotaInput, setTokenQuotaInput] = useState(row.token_quota === null ? "" : String(row.token_quota));
  const [requestQuotaInput, setRequestQuotaInput] = useState(row.request_quota === null ? "" : String(row.request_quota));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const payload: Record<string, unknown> = {};

    // 「不限」（null）本身即最宽，只能从有限额度放宽而来，不允许把有限额度改回不限。
    const tokenValue = parseQuota(tokenQuotaInput);
    if (tokenValue === undefined) {
      toast.error("Token 额度需为不小于 1 的整数，留空表示不限");
      return;
    }
    const requestValue = parseQuota(requestQuotaInput);
    if (requestValue === undefined) {
      toast.error("请求额度需为不小于 1 的整数，留空表示不限");
      return;
    }

    const maxUses = Number(maxUsesInput);
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      toast.error("最多兑换次数需为不小于 0 的整数，0 表示不限");
      return;
    }

    // 有效期不能留空：null 会让 atomic 核销的 SQL 判定豁免过期，收紧额度却永远不失效。
    const nextExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    if (nextExpiresAt === null) {
      toast.error("有效期不能留空，请填写一个不早于当前有效期的到期时间");
      return;
    }

    if (tokenValue === null) {
      if (row.token_quota !== null) {
        toast.error("Token 额度只能上调，不能改为不限；如需放宽请停用旧码并重新生成");
        return;
      }
    } else if (row.token_quota !== null && tokenValue < row.token_quota) {
      toast.error("Token 额度只能上调，不能下调");
      return;
    }

    if (requestValue === null) {
      if (row.request_quota !== null) {
        toast.error("请求额度只能上调，不能改为不限；如需放宽请停用旧码并重新生成");
        return;
      }
    } else if (row.request_quota !== null && requestValue < row.request_quota) {
      toast.error("请求额度只能上调，不能下调");
      return;
    }

    if (nextExpiresAt !== null && row.expires_at !== null && new Date(nextExpiresAt).getTime() < new Date(row.expires_at).getTime()) {
      toast.error("有效期只能延长，不能缩短");
      return;
    }

    if (maxUses !== 0 && row.max_uses !== 0 && maxUses < row.max_uses) {
      toast.error("最多兑换次数只能放宽，不能收紧");
      return;
    }
    if (maxUses !== 0 && maxUses < row.used_count) {
      toast.error(`该兑换码已被兑换 ${row.used_count} 次，最多兑换次数不能小于该值`);
      return;
    }

    if (tokenValue !== row.token_quota) payload.token_quota = tokenValue;
    if (requestValue !== row.request_quota) payload.request_quota = requestValue;
    if (maxUses !== row.max_uses) payload.max_uses = maxUses;
    if (nextExpiresAt !== normalized(row.expires_at)) payload.expires_at = nextExpiresAt;

    const trimmedNote = note.trim();
    const nextNote = trimmedNote ? trimmedNote : null;
    if (nextNote !== (row.note ?? null)) payload.note = nextNote;

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

  // 存储值按 ISO 归一化后再比较，避免时区/格式差异导致「无改动也提交」。
  function normalized(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

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
              <Label>有效期（只能延长，不可留空）</Label>
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
            <div>
              <Label>最多兑换次数（0 表示不限，只能放宽）</Label>
              <Input type="number" min={0} value={maxUsesInput} onChange={(e) => setMaxUsesInput(e.target.value)} />
            </div>
            <div>
              <Label>Token 额度（留空表示不限，只能上调）</Label>
              <Input
                type="number"
                min={1}
                value={tokenQuotaInput}
                onChange={(e) => setTokenQuotaInput(e.target.value)}
                placeholder="不限"
              />
            </div>
            <div>
              <Label>请求额度（留空表示不限，只能上调）</Label>
              <Input
                type="number"
                min={1}
                value={requestQuotaInput}
                onChange={(e) => setRequestQuotaInput(e.target.value)}
                placeholder="不限"
              />
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
