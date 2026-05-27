"use client";

import { AlertDialogAction } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLimit, formatNumber } from "@/lib/shared/formatters";
import { formatPeriodLabel, type UserRow } from "./user-model";

export function UserTable({
  rows,
  oidcFeatureEnabled,
  periodQuotaEnabled,
  onCreate,
  onEdit,
  onResetUsage,
  onRemove,
}: {
  rows: UserRow[];
  oidcFeatureEnabled: boolean;
  periodQuotaEnabled: boolean;
  onCreate: () => void;
  onEdit: (row: UserRow) => void;
  onResetUsage: (id: number, type: "all" | "total" | "period") => void;
  onRemove: (id: number) => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="暂无用户数据"
        description="当前没有匹配的用户记录，可以尝试调整搜索条件。"
        action={<Button onClick={onCreate}>新增用户</Button>}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <Table className={periodQuotaEnabled ? "min-w-[1620px] table-fixed" : "min-w-[1440px] table-fixed"}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">用户名</TableHead>
            <TableHead className="w-[180px]">标签</TableHead>
            <TableHead className="w-[120px]">用户组</TableHead>
            <TableHead className="w-[220px]">备注</TableHead>
            <TableHead className="w-[180px]">限速 RPM/QPS/TPM</TableHead>
            <TableHead className="w-[150px]">累计 请求/Token</TableHead>
            <TableHead className="w-[150px]">配额 请求/Token</TableHead>
            {periodQuotaEnabled ? <TableHead className="w-[180px]">周期配额</TableHead> : null}
            <TableHead className="w-[260px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium text-[var(--color-foreground)]">
                <span className="block truncate" title={row.username}>{row.username}</span>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={row.role === "admin" ? "default" : "secondary"}>
                    {row.role === "admin" ? "管理员" : "普通用户"}
                  </Badge>
                  <Badge variant={row.enabled ? "default" : "secondary"}>
                    {row.enabled ? "启用" : "禁用"}
                  </Badge>
                  {oidcFeatureEnabled && row.oidc_subject ? (
                    <Badge variant="outline" title={`${row.oidc_issuer}\n${row.oidc_subject}`}>OIDC</Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <span className="block truncate text-sm text-[var(--color-foreground-secondary)]" title={row.group_name ?? ""}>
                  {row.group_name ?? "-"}
                </span>
              </TableCell>
              <TableCell>
                <span className="block truncate text-sm text-[var(--color-foreground-secondary)]" title={row.note ?? ""}>
                  {row.note?.trim() || "-"}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="block truncate font-mono text-sm"
                  title={`生效: ${formatLimit(row.effective_rpm)}/${formatLimit(row.effective_qps)}/${formatLimit(row.effective_tpm)}\n用户: ${formatLimit(row.rpm)}/${formatLimit(row.qps)}/${formatLimit(row.tpm)}`}
                >
                  {formatLimit(row.effective_rpm)}/{formatLimit(row.effective_qps)}/{formatLimit(row.effective_tpm)}
                </span>
              </TableCell>
              <TableCell>
                <span className="block truncate font-mono text-sm" title="请求 / Token">
                  {formatNumber(row.used_requests)} / {formatNumber(row.used_tokens)}
                </span>
              </TableCell>
              <TableCell>
                <span className="block truncate font-mono text-sm" title="请求 / Token">
                  {row.effective_quota_requests === null ? "∞" : formatNumber(row.effective_quota_requests)}
                  {" / "}
                  {row.effective_quota_tokens === null ? "∞" : formatNumber(row.effective_quota_tokens)}
                </span>
              </TableCell>
              {periodQuotaEnabled ? (
                <TableCell>
                  {row.effective_quota_period ? (
                    <div className="space-y-0.5 text-sm">
                      <p className="font-medium text-[var(--color-foreground)]">{formatPeriodLabel(row.effective_quota_period)}</p>
                      <p className="text-xs text-[var(--color-foreground-muted)]">
                        请求 {row.effective_period_quota_requests === null ? "∞" : formatLimit(row.effective_period_quota_requests)}
                        {" / "}
                        Token {row.effective_period_quota_tokens === null ? "∞" : formatLimit(row.effective_period_quota_tokens)}
                      </p>
                      <p className="text-xs text-[var(--color-foreground-muted)]">
                        已用 {formatNumber(row.period_used_requests)} / {formatNumber(row.period_used_tokens)}
                      </p>
                    </div>
                  ) : <span className="text-sm text-[var(--color-foreground-muted)]">-</span>}
                </TableCell>
              ) : null}
              <TableCell className="space-x-2 whitespace-nowrap text-right">
                <Button size="sm" variant="outline" onClick={() => onEdit(row)}>编辑</Button>
                {periodQuotaEnabled ? (
                  <ConfirmDialog
                    trigger={<Button size="sm" variant="outline">重置用量</Button>}
                    title={`重置用户 ${row.username} 的用量？`}
                    description="选择要重置的用量类型，重置后不可恢复。"
                    actions={<>
                      <AlertDialogAction onClick={() => onResetUsage(row.id, "period")}>仅周期用量</AlertDialogAction>
                      <AlertDialogAction onClick={() => onResetUsage(row.id, "total")}>仅总用量</AlertDialogAction>
                      <AlertDialogAction onClick={() => onResetUsage(row.id, "all")}>全部重置</AlertDialogAction>
                    </>}
                  />
                ) : (
                  <ConfirmDialog
                    trigger={<Button size="sm" variant="outline">重置用量</Button>}
                    title={`重置用户 ${row.username} 的总用量？`}
                    description="重置后不可恢复。"
                    confirmText="确认重置"
                    onConfirm={() => onResetUsage(row.id, "total")}
                  />
                )}
                <ConfirmDialog
                  title={`删除用户 ${row.username}？`}
                  description="删除后该用户的登录入口会立即失效，此操作不可撤销。"
                  onConfirm={() => onRemove(row.id)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
