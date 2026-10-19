"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authedFetch } from "@/lib/auth/client-auth";
import { parseGroupIds, redeemCodeKindLabel, type CodeRow, type GroupOption } from "./redeem-code-types";

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

// 去重升序后与原值比较，决定是否提交 allowed_group_ids。
function normalizeGroupIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

// 用 key 重挂载来初始化表单，避免在 effect 里同步 setState。
export function RedeemCodeEditDialog({
  row,
  groups,
  onClose,
  onSaved,
}: {
  row: CodeRow;
  groups: GroupOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(row.note ?? "");
  const [expiresAt, setExpiresAt] = useState(toLocalInput(row.expires_at));
  const [maxUsesInput, setMaxUsesInput] = useState(String(row.max_uses));
  const isReset = row.kind === "reset";
  const [tokenQuotaInput, setTokenQuotaInput] = useState(row.token_quota === null ? "" : String(row.token_quota));
  const [requestQuotaInput, setRequestQuotaInput] = useState(row.request_quota === null ? "" : String(row.request_quota));
  const [groupIds, setGroupIds] = useState<number[]>(() => parseGroupIds(row.allowed_group_ids));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const payload: Record<string, unknown> = {};

    // 「不限」（null）本身即最宽，只能从有限额度放宽而来，不允许把有限额度改回不限。
    // 重置券不发放额度，额度字段既不可编辑也不提交。
    const tokenValue = isReset ? null : parseQuota(tokenQuotaInput);
    if (tokenValue === undefined) {
      toast.error("Token 额度需为不小于 1 的整数，留空表示不限");
      return;
    }
    const requestValue = isReset ? null : parseQuota(requestQuotaInput);
    if (requestValue === undefined) {
      toast.error("请求额度需为不小于 1 的整数，留空表示不限");
      return;
    }

    const maxUses = Number(maxUsesInput);
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      toast.error("最多兑换次数需为不小于 0 的整数，0 表示不限");
      return;
    }

    // 有效期留空分两种：原本就是长期有效（null）时表示「不改有效期」，
    // 直接不提交该字段；原本有限期的清空则会被后端当成「改成长期有效」而拒绝。
    const expiresAtTouched = expiresAt !== toLocalInput(row.expires_at);
    const nextExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    if (expiresAtTouched && nextExpiresAt === null) {
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
    if (expiresAtTouched && nextExpiresAt !== normalized(row.expires_at)) payload.expires_at = nextExpiresAt;

    const trimmedNote = note.trim();
    const nextNote = trimmedNote ? trimmedNote : null;
    if (nextNote !== (row.note ?? null)) payload.note = nextNote;

    // 与原值（去重升序）相同则不提交；不同则整体替换，空选传 [] 表示清空为不限。
    const currentGroupIds = normalizeGroupIds(parseGroupIds(row.allowed_group_ids));
    const nextGroupIds = normalizeGroupIds(groupIds);
    if (currentGroupIds.length !== nextGroupIds.length || currentGroupIds.some((id, index) => id !== nextGroupIds[index])) {
      payload.allowed_group_ids = nextGroupIds;
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
      if (Array.isArray(data?.warnings)) {
        for (const warning of data.warnings as string[]) toast.warning(warning);
      }
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
            {isReset
              ? "重置券不发放额度，只能调整备注、有效期与最多兑换次数。兑换码本身、批次与限定渠道/模型不可修改；限定用户组可调整。"
              : "额度与有效期「只增不减」，别让已兑换的用户凭空失效。兑换码本身、批次与限定渠道/模型不可修改；限定用户组可调整。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] p-3 text-sm">
            <span className="text-[var(--color-foreground-muted)]">兑换码：</span>
            <span className="font-mono">{row.code}</span>
            <Badge variant={isReset ? "secondary" : "default"}>{redeemCodeKindLabel(row.kind)}</Badge>
            <span className="text-[var(--color-foreground-muted)]">批次：</span>
            <span className="break-all font-mono text-xs">{row.batch_id}</span>
          </div>
          <div>
            <Label>备注</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{row.expires_at == null ? "有效期（长期有效，如需设置请填写）" : "有效期（只能延长）"}</Label>
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
                {row.expires_at == null
                  ? "留空表示长期有效；已有人兑换时无法再设置，设置后不能改回长期有效"
                  : "不支持清空有效期；如需永久有效请停用该码并重新生成"}
              </p>
            </div>
            <div>
              <Label>最多兑换次数（0 表示不限，只能放宽）</Label>
              <Input type="number" min={0} value={maxUsesInput} onChange={(e) => setMaxUsesInput(e.target.value)} />
            </div>
            {isReset ? null : (
              <>
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
              </>
            )}
          </div>

          <div>
            <Label>限定用户组（不选表示不限）</Label>
            <div className="mt-1 flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-[var(--color-border)] p-3">
              {groups.length === 0 ? (
                <span className="text-xs text-[var(--color-foreground-muted)]">暂无可用用户组</span>
              ) : (
                groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setGroupIds((prev) => (prev.includes(g.id) ? prev.filter((id) => id !== g.id) : [...prev, g.id]))}
                    className={`rounded-full px-3 py-1 text-xs transition-colors ${groupIds.includes(g.id) ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]"}`}
                  >
                    {g.name}{g.enabled === 0 ? "（已停用）" : ""}
                  </button>
                ))
              )}
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
