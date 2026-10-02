"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatNumber, formatTokenCount } from "@/lib/shared/utils";
import type { CodeRow } from "./redeem-code-types";

type RedemptionRow = {
  id: number;
  code_id: number;
  user_id: number;
  username: string | null;
  redeemed_at: string;
  token_quota: number | null;
  request_quota: number | null;
  used_tokens: number | null;
  used_requests: number | null;
  // 来自该用户持有的定向额度（redeem_balances）而非兑换码本身，两者过期时间可能不同。
  expires_at: string | null;
};

type DetailData = {
  data: CodeRow;
  redemptions: { data: RedemptionRow[]; total: number };
};

const pageSize = 20;

// 额度为 null 表示不限，否则按「额度 - 已用」展示剩余。
function remainingToken(quota: number | null, used: number | null): string {
  if (quota === null || quota === undefined) return "不限";
  return formatTokenCount(Math.max(0, quota - (used ?? 0)));
}

function remainingRequest(quota: number | null, used: number | null): string {
  if (quota === null || quota === undefined) return "不限";
  return formatNumber(Math.max(0, quota - (used ?? 0)));
}

export function RedeemCodeDetailDialog({
  codeId,
  detail,
  page,
  loading,
  onPageChange,
  onClose,
}: {
  codeId: number;
  detail: DetailData | null;
  page: number;
  loading: boolean;
  onPageChange: (page: number) => void;
  onClose: () => void;
}) {
  const code = detail?.data;
  const redemptions = detail?.redemptions;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>兑换码详情</DialogTitle>
          <DialogDescription>
            列表按码聚合，这里看逐条领取记录：领取人、领取时间、每人剩余额度与各自额度的有效期。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {code ? (
            <div className="grid gap-2 rounded-xl border border-[var(--color-border)] p-3 text-sm sm:grid-cols-2">
              <div className="font-mono sm:col-span-2">{code.code}</div>
              <div>剩余额度（Token）：{remainingToken(code.token_quota, code.used_tokens_sum)}</div>
              <div>剩余额度（请求）：{remainingRequest(code.request_quota, code.used_requests_sum)}</div>
              <div>
                已兑换 {formatNumber(code.redeemed_users)} 人 / 使用 {code.used_count}
                {code.max_uses === 0 ? " 次（不限）" : ` / ${code.max_uses} 次`}
              </div>
              <div>创建人：{code.created_by_username ?? "—"}</div>
              <div>创建时间：{new Date(code.created_at).toLocaleString()}</div>
              <div>有效期：{code.expires_at ? new Date(code.expires_at).toLocaleString() : "长期有效"}</div>
              <div className="sm:col-span-2">备注：{code.note ?? "—"}</div>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>领取人</TableHead>
                  <TableHead>领取时间</TableHead>
                  <TableHead>剩余 Token</TableHead>
                  <TableHead>剩余请求</TableHead>
                  <TableHead>额度有效期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!redemptions || redemptions.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-[var(--color-foreground-muted)]">
                      {loading ? "加载中…" : "尚无人兑换"}
                    </TableCell>
                  </TableRow>
                ) : (
                  redemptions.data.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.username ?? `#${row.user_id}`}</TableCell>
                      <TableCell>{new Date(row.redeemed_at).toLocaleString()}</TableCell>
                      <TableCell>{remainingToken(row.token_quota, row.used_tokens)}</TableCell>
                      <TableCell>{remainingRequest(row.request_quota, row.used_requests)}</TableCell>
                      <TableCell>{row.expires_at ? new Date(row.expires_at).toLocaleString() : "长期有效"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {redemptions && redemptions.total > pageSize ? (
            <PagePagination
              page={page}
              total={redemptions.total}
              pageSize={pageSize}
              label={`共 ${formatNumber(redemptions.total)} 条领取记录`}
              onPageChange={onPageChange}
            />
          ) : null}

          <p className="text-xs text-[var(--color-foreground-muted)]">
            兑换码 #{codeId}，剩余额度按「额度 - 已用」计算，不限额度不做扣减统计；有效期列为该用户所持额度的到期时间。
          </p>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 打开详情弹窗时拉取数据，避免在 effect 里同步 setState。
export function useRedeemCodeDetail() {
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // 请求序号：快速切换兑换码或翻页时，丢弃早发但晚到的响应，避免旧数据覆盖新数据。
  const requestSeq = useRef(0);

  const loadDetail = useCallback(async (id: number, targetPage: number) => {
    const seq = ++requestSeq.current;
    setLoadingDetail(true);
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((targetPage - 1) * pageSize) });
      const res = await authedFetch(`/api/admin/redeem-codes/${id}?${params.toString()}`);
      const data = await res.json().catch(() => null);
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        toast.error(data?.error?.message ?? "加载详情失败");
        return;
      }
      setDetail(data as DetailData);
      setDetailPage(targetPage);
    } finally {
      if (seq === requestSeq.current) setLoadingDetail(false);
    }
  }, []);

  const openDetail = useCallback((id: number) => {
    setDetailId(id);
    setDetail(null);
    void loadDetail(id, 1);
  }, [loadDetail]);

  const closeDetail = useCallback(() => {
    requestSeq.current += 1;
    setDetailId(null);
  }, []);

  const changeDetailPage = useCallback((targetPage: number) => {
    if (detailId === null) return;
    void loadDetail(detailId, targetPage);
  }, [detailId, loadDetail]);

  return { detailId, detail, detailPage, loadingDetail, openDetail, closeDetail, changeDetailPage };
}
