"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { authedFetch, ensureAdmin } from "@/lib/auth/client-auth";
import { modelGateFeatures } from "@/lib/core/features";
import { getApiMessage } from "@/lib/shared/api-message";
import {
  initialForm,
  periodToPreset,
  type AliasOption,
  type ChannelOption,
  type GroupForm,
  type GroupRow,
} from "./group-model";

type GroupsResponse = {
  data?: GroupRow[];
};

function buildGroupForm(row: GroupRow): GroupForm {
  const preset = periodToPreset(row.quota_period);
  return {
    name: row.name,
    description: row.description ?? "",
    qps: row.qps,
    rpm: row.rpm,
    tpm: row.tpm,
    quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
    quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
    quota_period_preset: preset,
    quota_period_custom: preset === "custom" && row.quota_period ? String(row.quota_period) : "",
    period_quota_tokens: row.period_quota_tokens === null ? "" : String(row.period_quota_tokens),
    period_quota_requests: row.period_quota_requests === null ? "" : String(row.period_quota_requests),
    allowed_model_aliases: row.allowed_model_aliases ?? [],
    allowed_channel_ids: row.allowed_channel_ids ?? [],
    oidc_claim_expr: row.oidc_claim_expr ?? "",
    oidc_claim_priority: String(row.oidc_claim_priority ?? 0),
    is_default: row.is_default === 1,
    enabled: row.enabled === 1,
  };
}

function buildGroupPayload(
  form: GroupForm,
  periodQuotaEnabled: boolean,
  oidcFeatureEnabled: boolean,
) {
  const periodValue = form.quota_period_preset === "custom"
    ? (form.quota_period_custom.trim() === "" ? null : Number(form.quota_period_custom))
    : (form.quota_period_preset === "" ? null : Number(form.quota_period_preset));

  return {
    name: form.name,
    description: form.description.trim() || null,
    qps: form.qps,
    rpm: form.rpm,
    tpm: form.tpm,
    quota_requests: form.quota_requests.trim() === "" ? null : Number(form.quota_requests),
    quota_tokens: form.quota_tokens.trim() === "" ? null : Number(form.quota_tokens),
    ...(periodQuotaEnabled ? {
      quota_period: periodValue,
      period_quota_tokens: form.period_quota_tokens.trim() === "" ? null : Number(form.period_quota_tokens),
      period_quota_requests: form.period_quota_requests.trim() === "" ? null : Number(form.period_quota_requests),
    } : {}),
    allowed_model_aliases: form.allowed_model_aliases,
    allowed_channel_ids: form.allowed_channel_ids,
    ...(oidcFeatureEnabled ? {
      oidc_claim_expr: form.oidc_claim_expr.trim() || null,
      oidc_claim_priority: Number(form.oidc_claim_priority) || 0,
    } : {}),
    is_default: form.is_default,
    enabled: form.enabled,
  };
}

export function useGroupAdmin() {
  const router = useRouter();
  const { toast } = useToast();
  const oidcFeatureEnabled = modelGateFeatures.oidc;
  const periodQuotaEnabled = modelGateFeatures.periodQuota;

  const [rows, setRows] = useState<GroupRow[]>([]);
  const [form, setForm] = useState<GroupForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [aliasOptions, setAliasOptions] = useState<AliasOption[]>([]);
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([]);

  async function loadGroups() {
    if (!(await ensureAdmin(router))) return;
    const response = await authedFetch("/api/admin/groups?limit=100");
    const data = (await response.json()) as GroupsResponse;
    if (response.ok) {
      setRows(data.data ?? []);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const profile = await ensureAdmin(router);
      if (cancelled || !profile) return;
      const [groupsRes, modelsRes, channelsRes] = await Promise.all([
        authedFetch("/api/admin/groups?limit=100"),
        authedFetch("/api/admin/models"),
        authedFetch("/api/admin/channels"),
      ]);
      if (cancelled) return;
      const groupsData = (await groupsRes.json()) as GroupsResponse;
      if (groupsRes.ok) {
        setRows(groupsData.data ?? []);
      }
      const modelsData = await modelsRes.json().catch(() => null);
      if (cancelled) return;
      if (modelsRes.ok) {
        const items = Array.isArray(modelsData?.data) ? (modelsData.data as AliasOption[]) : [];
        const unique = new Map<string, AliasOption>();
        for (const row of items) {
          if (row.is_public === 1) continue;
          if (!unique.has(row.alias)) unique.set(row.alias, row);
        }
        setAliasOptions([...unique.values()].sort((a, b) => a.alias.localeCompare(b.alias)));
      }
      const channelsData = await channelsRes.json().catch(() => null);
      if (cancelled) return;
      if (channelsRes.ok) {
        const items = Array.isArray(channelsData?.data) ? (channelsData.data as ChannelOption[]) : [];
        setChannelOptions(
          items
            .map((channel) => ({ id: channel.id, name: channel.name, enabled: channel.enabled }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [router]);

  function updateForm(patch: Partial<GroupForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function openCreateGroup() {
    setEditingId(null);
    setForm(initialForm);
    setDrawerOpen(true);
  }

  function openEditGroup(row: GroupRow) {
    setEditingId(row.id);
    setForm(buildGroupForm(row));
    setDrawerOpen(true);
  }

  function toggleAllowedAlias(alias: string) {
    setForm((current) => ({
      ...current,
      allowed_model_aliases: current.allowed_model_aliases.includes(alias)
        ? current.allowed_model_aliases.filter((item) => item !== alias)
        : [...current.allowed_model_aliases, alias].sort(),
    }));
  }

  function toggleAllowedChannel(channelId: number) {
    setForm((current) => ({
      ...current,
      allowed_channel_ids: current.allowed_channel_ids.includes(channelId)
        ? current.allowed_channel_ids.filter((id) => id !== channelId)
        : [...current.allowed_channel_ids, channelId].sort((a, b) => a - b),
    }));
  }

  async function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildGroupPayload(form, periodQuotaEnabled, oidcFeatureEnabled);

    if (editingId === null) {
      const response = await authedFetch("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建用户组成功。") });
        setDrawerOpen(false);
        setForm(initialForm);
        await loadGroups();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建用户组失败。") });
      return;
    }

    const response = await authedFetch(`/api/admin/groups/${editingId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新用户组成功。") });
      setDrawerOpen(false);
      setEditingId(null);
      setForm(initialForm);
      await loadGroups();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新用户组失败。") });
  }

  async function removeGroup(id: number) {
    const response = await authedFetch(`/api/admin/groups/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除用户组成功。") });
      await loadGroups();
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除用户组失败。") });
  }

  return {
    rows,
    form,
    updateForm,
    drawerOpen,
    setDrawerOpen,
    editingId,
    aliasOptions,
    channelOptions,
    oidcFeatureEnabled,
    periodQuotaEnabled,
    openCreateGroup,
    openEditGroup,
    toggleAllowedAlias,
    toggleAllowedChannel,
    submitGroup,
    removeGroup,
  };
}
