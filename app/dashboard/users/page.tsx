"use client";

import { PagePagination } from "@/components/dashboard/page-pagination";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/shared/formatters";
import { UserDrawer } from "./user-drawer";
import { useUserAdmin } from "./use-user-admin";
import { UserTable } from "./user-table";
import type { UserSortKey } from "./user-model";

export default function AdminUsersPage() {
  const admin = useUserAdmin();

  return (
    <DashboardShell
      role="admin"
      title="用户管理"
      subtitle="管理账号角色、启用状态、速率限制和模型访问范围。"
    >
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="用户列表" description="支持分页搜索、编辑角色与限额配置。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <PageToolbar>
              <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_160px_180px_130px_140px_auto_auto]">
                <Input
                  placeholder="搜索用户名"
                  value={admin.keyword}
                  onChange={(event) => admin.setKeyword(event.target.value)}
                />
                <Select value={admin.groupFilter} onValueChange={admin.selectGroupFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="按分组筛选" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部分组</SelectItem>
                    {admin.groupOptions.map((group) => (
                      <SelectItem key={group.id} value={String(group.id)}>
                        {group.name}{group.is_default ? "（默认）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={admin.roleFilter} onValueChange={admin.selectRoleFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="按角色筛选" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部角色</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                    <SelectItem value="user">普通用户</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={admin.sortBy} onValueChange={(value) => admin.setSortBy(value as UserSortKey)}>
                  <SelectTrigger>
                    <SelectValue placeholder="排序字段" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="created_at">按创建时间</SelectItem>
                    <SelectItem value="used_requests">按累计请求</SelectItem>
                    <SelectItem value="used_tokens">按累计 Token</SelectItem>
                    <SelectItem value="username">按用户名</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={admin.sortDir} onValueChange={(value) => admin.setSortDir(value as "asc" | "desc")}>
                  <SelectTrigger>
                    <SelectValue placeholder="排序方向" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">降序</SelectItem>
                    <SelectItem value="asc">升序</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={admin.searchUsers}>搜索</Button>
                <Button variant="ghost" onClick={admin.resetFilters}>重置</Button>
              </div>
              <Button onClick={admin.openCreateUser}>新增用户</Button>
            </PageToolbar>

            <UserTable
              rows={admin.rows}
              oidcFeatureEnabled={admin.oidcFeatureEnabled}
              periodQuotaEnabled={admin.periodQuotaEnabled}
              onCreate={admin.openCreateUser}
              onEdit={admin.openEditUser}
              onResetUsage={(id, type) => { void admin.resetUsage(id, type); }}
              onRemove={(id) => { void admin.removeUser(id); }}
            />

            <PagePagination
              page={admin.page}
              total={admin.total}
              pageSize={admin.pageSize}
              label={`共 ${formatNumber(admin.total)} 个用户`}
              onPageChange={(page) => { void admin.loadUsers(page); }}
            />
          </CardContent>
        </Card>
      </div>

      <UserDrawer
        open={admin.drawerOpen}
        onOpenChange={admin.setDrawerOpen}
        editingId={admin.editingId}
        form={admin.form}
        groupOptions={admin.groupOptions}
        aliasOptions={admin.aliasOptions}
        oidcFeatureEnabled={admin.oidcFeatureEnabled}
        periodQuotaEnabled={admin.periodQuotaEnabled}
        editingOidc={admin.editingOidc}
        editingGroupLimits={admin.editingGroupLimits}
        onFormChange={admin.updateForm}
        onToggleAllowedAlias={admin.toggleAllowedAlias}
        onSubmit={admin.submitUser}
      />
    </DashboardShell>
  );
}
