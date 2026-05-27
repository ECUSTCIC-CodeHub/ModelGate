"use client";

import { ConfirmDialog } from "@/components/dashboard/confirm-dialog";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLimit } from "@/lib/shared/formatters";
import { formatPeriodLabel, type GroupRow } from "./group-model";

export function GroupTable({
  rows,
  periodQuotaEnabled,
  onCreate,
  onEdit,
  onRemove,
}: {
  rows: GroupRow[];
  periodQuotaEnabled: boolean;
  onCreate: () => void;
  onEdit: (row: GroupRow) => void;
  onRemove: (id: number) => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="暂无用户组"
        description="创建用户组来批量管理用户的限流和模型访问权限。"
        action={<Button onClick={onCreate}>新增用户组</Button>}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead>组名</TableHead>
            <TableHead>描述</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>默认</TableHead>
            <TableHead>用户数</TableHead>
            <TableHead>限速 (RPM/QPS/TPM)</TableHead>
            <TableHead>请求配额</TableHead>
            <TableHead>Token 配额</TableHead>
            {periodQuotaEnabled ? <TableHead>周期配额</TableHead> : null}
            <TableHead>模型白名单</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="max-w-48">
                <span className="block truncate text-[var(--color-foreground-secondary)]" title={row.description ?? ""}>
                  {row.description?.trim() || "-"}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "启用" : "禁用"}</Badge>
              </TableCell>
              <TableCell>
                {row.is_default ? <Badge variant="default">默认</Badge> : "-"}
              </TableCell>
              <TableCell>{row.user_count}</TableCell>
              <TableCell>{formatLimit(row.rpm)}/{formatLimit(row.qps)}/{formatLimit(row.tpm)}</TableCell>
              <TableCell>{row.quota_requests === null ? "∞" : formatLimit(row.quota_requests)}</TableCell>
              <TableCell>{row.quota_tokens === null ? "∞" : formatLimit(row.quota_tokens)}</TableCell>
              {periodQuotaEnabled ? (
                <TableCell>
                  {row.quota_period ? (
                    <div className="space-y-0.5 text-sm">
                      <p className="font-medium text-[var(--color-foreground)]">{formatPeriodLabel(row.quota_period)}</p>
                      <p className="text-xs text-[var(--color-foreground-muted)]">
                        请求 {row.period_quota_requests === null ? "∞" : formatLimit(row.period_quota_requests)}
                        {" / "}
                        Token {row.period_quota_tokens === null ? "∞" : formatLimit(row.period_quota_tokens)}
                      </p>
                    </div>
                  ) : "-"}
                </TableCell>
              ) : null}
              <TableCell className="max-w-48">
                <span className="block truncate text-[var(--color-foreground-secondary)]">
                  {row.allowed_model_aliases.length > 0 ? row.allowed_model_aliases.join(", ") : "-"}
                </span>
              </TableCell>
              <TableCell className="space-x-2 text-right">
                <Button size="sm" variant="outline" onClick={() => onEdit(row)}>编辑</Button>
                {row.is_default ? null : (
                  <ConfirmDialog
                    title={`删除用户组 ${row.name}？`}
                    description={
                      row.user_count > 0
                        ? `该组下仍有 ${row.user_count} 个用户，需先移除或转移用户后才能删除。`
                        : "删除后不可恢复，此操作不可撤销。"
                    }
                    onConfirm={() => onRemove(row.id)}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
