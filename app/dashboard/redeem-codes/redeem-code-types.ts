export type ChannelOption = { id: number; name: string };
export type ModelOption = { alias: string; real_model: string };
export type GroupOption = { id: number; name: string; enabled?: number };

// quota 为额度券（发放定向额度），reset 为重置券（只清零核销人的周期用量）。
export type RedeemCodeKind = "quota" | "reset";

export const REDEEM_CODE_KIND_LABELS: Record<RedeemCodeKind, string> = {
  quota: "额度券",
  reset: "重置券",
};

export function redeemCodeKindLabel(kind: string | null | undefined): string {
  return kind === "reset" ? REDEEM_CODE_KIND_LABELS.reset : REDEEM_CODE_KIND_LABELS.quota;
}

export type CodeRow = {
  id: number;
  code: string;
  batch_id: string;
  kind: RedeemCodeKind;
  token_quota: number | null;
  request_quota: number | null;
  period_cycles: string | null;
  allowed_channel_ids: string;
  allowed_model_aliases: string;
  allowed_group_ids: string;
  expires_at: string | null;
  enabled: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by: number | null;
  created_by_username: string | null;
  redeemed_users: number;
  used_tokens_sum: number;
  used_requests_sum: number;
  created_at: string;
};

// 与页面 parseChannelIds 同款容错：非法 JSON、非数组、非正整数项一律视为不限。
export function parseGroupIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0)
      : [];
  } catch {
    return [];
  }
}

// 组名以「、」连接；未知 id 回退 #id；空数组按不限展示。
export function formatGroupNames(ids: number[], groups: GroupOption[]): string {
  if (ids.length === 0) return "不限";
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return ids.map((id) => names.get(id) ?? `#${id}`).join("、");
}

// 批次号由生成时间戳与随机串组成（如 1725000000000-a1b2c3d4）。
// 展示成可读时间 + 短后缀；格式不符时原样返回，避免解析失败把批次号吞掉。
export function formatBatchLabel(batchId: string): string {
  const match = /^(\d{10,})-[0-9a-z]+$/i.exec(batchId);
  if (!match) return batchId;
  const date = new Date(Number(match[1]));
  if (Number.isNaN(date.getTime())) return batchId;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${stamp} · ${batchId.slice(batchId.lastIndexOf("-") + 1)}`;
}
