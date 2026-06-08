"use client";

import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelDrawer } from "./channel-drawer";
import { ChannelTable } from "./channel-table";
import { ModelDrawer } from "./model-drawer";
import { ModelTable } from "./model-table";
import { UpstreamModelPicker } from "./upstream-model-picker";
import { useChannelAdmin } from "./use-channel-admin";

export default function AdminChannelsPage() {
  const admin = useChannelAdmin();

  return (
    <DashboardShell
      role="admin"
      title="渠道与模型管理"
      subtitle="统一管理上游渠道、模型映射、状态、权重与测试动作。"
    >
      <div className="space-y-4 pb-6">
        {admin.error ? <p className="text-sm text-[var(--color-destructive)]">{admin.error}</p> : null}
        <Card>
          <CardHeader>
            <SectionTitle title="渠道与模型配置" description="在渠道标签页管理上游 API 接入，在模型标签页配置 alias 与真实模型映射。" />
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="channels" className="space-y-4">
              <TabsList>
                <TabsTrigger value="channels">渠道</TabsTrigger>
                <TabsTrigger value="models">模型映射</TabsTrigger>
              </TabsList>

              <TabsContent value="channels" className="space-y-4">
                <PageToolbar>
                  <p className="text-sm text-[var(--color-foreground-muted)]">渠道代表一条上游 API 接入，包含 Base URL、API Key、超时和权重。</p>
                  <Button onClick={admin.openCreateChannel}>新增渠道</Button>
                </PageToolbar>
                <ChannelTable
                  channels={admin.channels}
                  onCreate={admin.openCreateChannel}
                  onEdit={admin.openEditChannel}
                  onToggle={admin.toggleChannel}
                  onCreateModel={admin.openCreateModel}
                  onRemove={admin.removeChannel}
                />
              </TabsContent>

              <TabsContent value="models" className="space-y-4">
                <PageToolbar>
                  <p className="text-sm text-[var(--color-foreground-muted)]">模型映射决定外部调用时传入的 alias 如何路由到真实模型与渠道。</p>
                  <Button disabled={admin.channels.length === 0} onClick={() => admin.openCreateModel(admin.channels[0]?.id ?? 0)}>新增模型映射</Button>
                </PageToolbar>
                <ModelTable
                  models={admin.allModels}
                  channelsCount={admin.channels.length}
                  testingModelId={admin.testingModelId}
                  onCreate={() => admin.openCreateModel(admin.channels[0]?.id ?? 0)}
                  onTest={admin.testModel}
                  onEdit={admin.openEditModel}
                  onToggle={admin.toggleModel}
                  onRemove={admin.removeModel}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <ChannelDrawer
        open={admin.channelDrawerOpen}
        editingId={admin.channelEditingId}
        form={admin.channelForm}
        modelDrafts={admin.channelModels}
        probingModels={admin.probingModels}
        periodQuotaEnabled={admin.periodQuotaEnabled}
        dismissBlocked={admin.upstreamPickerOpen}
        onOpenChange={admin.setChannelDrawerOpen}
        onSubmit={admin.submitChannel}
        onFormChange={admin.updateChannelForm}
        onSupportedProtocolsChange={admin.updateSupportedProtocols}
        onProbeModels={() => void admin.probeUpstreamModels(admin.channelForm.base_url, admin.channelForm.api_key, admin.channelForm.user_agent, admin.channelForm.proxy_url)}
        onAddModelDraft={admin.addChannelModelDraft}
        onRemoveModelDraft={admin.removeChannelModelDraft}
        onUpdateModelDraft={admin.updateChannelModelDraft}
      />

      <ModelDrawer
        open={admin.modelDrawerOpen}
        editingId={admin.modelEditingId}
        form={admin.modelForm}
        channels={admin.channels}
        selectedChannel={admin.selectedChannel}
        selectedChannelProtocols={admin.selectedChannelProtocols}
        modelDrafts={admin.channelModels}
        probingModels={admin.probingModels}
        periodQuotaEnabled={admin.periodQuotaEnabled}
        dismissBlocked={admin.upstreamPickerOpen}
        onOpenChange={admin.setModelDrawerOpen}
        onSubmit={admin.submitModel}
        onFormChange={admin.updateModelForm}
        onChannelChange={admin.updateModelChannel}
        onProbeModels={() => void admin.probeUpstreamModels(admin.selectedChannel?.base_url ?? "", admin.selectedChannel?.api_key ?? "", admin.selectedChannel?.user_agent ?? "", admin.selectedChannel?.proxy_url ?? "", admin.selectedChannel?.models ?? [])}
        onAddModelDraft={admin.addChannelModelDraft}
        onRemoveModelDraft={admin.removeChannelModelDraft}
        onUpdateModelDraft={admin.updateChannelModelDraft}
      />

      <UpstreamModelPicker
        open={admin.upstreamPickerOpen}
        query={admin.upstreamPickerQuery}
        options={admin.upstreamModelOptions}
        onOpenChange={admin.setUpstreamPickerOpen}
        onQueryChange={admin.setUpstreamPickerQuery}
        onToggleModel={admin.toggleUpstreamModel}
        onSelectFiltered={admin.selectFilteredUpstreamModels}
        onConfirm={() => admin.confirmUpstreamModelSelection(admin.activeDraftProtocols)}
      />
    </DashboardShell>
  );
}
