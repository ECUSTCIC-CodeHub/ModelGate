"use client";

import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { GroupDrawer } from "./group-drawer";
import { GroupTable } from "./group-table";
import { useGroupAdmin } from "./use-group-admin";

export default function AdminGroupsPage() {
  const admin = useGroupAdmin();

  return (
    <DashboardShell
      role="admin"
      title="用户组管理"
      subtitle="管理用户组及其速率限制、配额和模型访问权限。组配置作为用户的默认值生效。"
    >
      <div className="space-y-4 pb-6">
        <Card>
          <CardHeader>
            <SectionTitle title="用户组列表" description="创建和管理用户组，为用户批量配置限流和模型白名单。" />
          </CardHeader>
          <CardContent className="space-y-4">
            <PageToolbar>
              <div />
              <Button onClick={admin.openCreateGroup}>新增用户组</Button>
            </PageToolbar>

            <GroupTable
              rows={admin.rows}
              periodQuotaEnabled={admin.periodQuotaEnabled}
              onCreate={admin.openCreateGroup}
              onEdit={admin.openEditGroup}
              onRemove={(id) => { void admin.removeGroup(id); }}
            />
          </CardContent>
        </Card>
      </div>

      <GroupDrawer
        open={admin.drawerOpen}
        onOpenChange={admin.setDrawerOpen}
        editingId={admin.editingId}
        form={admin.form}
        aliasOptions={admin.aliasOptions}
        oidcFeatureEnabled={admin.oidcFeatureEnabled}
        periodQuotaEnabled={admin.periodQuotaEnabled}
        onFormChange={admin.updateForm}
        onToggleAllowedAlias={admin.toggleAllowedAlias}
        onSubmit={admin.submitGroup}
      />
    </DashboardShell>
  );
}
