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
  type GroupOption,
  type UserForm,
  type UserGroupLimits,
  type UserOidcBinding,
  type UserRow,
  type UserSortKey,
} from "./user-model";

const PAGE_SIZE = 20;

type SortDirection = "asc" | "desc";
type ResetUsageType = "all" | "total" | "period";
type UsersListResponse = {
  data?: UserRow[];
  paging?: { total?: number };
  sorting?: {
    sort_by?: UserSortKey;
    sort_dir?: SortDirection;
  };
};

function pickGroupLimits(row: UserRow): UserGroupLimits | null {
  if (!row.group_id) return null;
  return {
    rpm: row.group_rpm,
    qps: row.group_qps,
    tpm: row.group_tpm,
    quota_requests: row.group_quota_requests,
    quota_tokens: row.group_quota_tokens,
    quota_period: row.group_quota_period,
    period_quota_tokens: row.group_period_quota_tokens,
    period_quota_requests: row.group_period_quota_requests,
  };
}

function buildUserForm(row: UserRow): UserForm {
  const preset = periodToPreset(row.quota_period);
  return {
    username: row.username,
    password: "",
    new_password: "",
    note: row.note ?? "",
    role: row.role,
    group_id: row.group_id !== null ? String(row.group_id) : "",
    enabled: row.enabled === 1,
    rpm: row.rpm,
    qps: row.qps,
    tpm: row.tpm,
    quota_tokens: row.quota_tokens === null ? "" : String(row.quota_tokens),
    quota_requests: row.quota_requests === null ? "" : String(row.quota_requests),
    quota_period_preset: preset,
    quota_period_custom: preset === "custom" && row.quota_period ? String(row.quota_period) : "",
    period_quota_tokens: row.period_quota_tokens === null ? "" : String(row.period_quota_tokens),
    period_quota_requests: row.period_quota_requests === null ? "" : String(row.period_quota_requests),
    allowed_model_aliases: row.allowed_model_aliases ?? [],
  };
}

function buildUserPayload(form: UserForm, periodQuotaEnabled: boolean) {
  const periodValue = form.quota_period_preset === "custom"
    ? (form.quota_period_custom.trim() === "" ? null : Number(form.quota_period_custom))
    : (form.quota_period_preset === "" ? null : Number(form.quota_period_preset));

  return {
    username: form.username,
    role: form.role,
    group_id: form.group_id ? Number(form.group_id) : null,
    enabled: form.enabled,
    rpm: form.rpm,
    qps: form.qps,
    tpm: form.tpm,
    quota_tokens: form.quota_tokens.trim() === "" ? null : Number(form.quota_tokens),
    quota_requests: form.quota_requests.trim() === "" ? null : Number(form.quota_requests),
    ...(periodQuotaEnabled ? {
      quota_period: periodValue,
      period_quota_tokens: form.period_quota_tokens.trim() === "" ? null : Number(form.period_quota_tokens),
      period_quota_requests: form.period_quota_requests.trim() === "" ? null : Number(form.period_quota_requests),
    } : {}),
    allowed_model_aliases: form.allowed_model_aliases,
    note: form.note.trim() === "" ? null : form.note.trim(),
    ...(form.new_password.trim() ? { new_password: form.new_password.trim() } : {}),
  };
}

export function useUserAdmin() {
  const router = useRouter();
  const { toast } = useToast();
  const periodQuotaEnabled = modelGateFeatures.periodQuota;
  const oidcFeatureEnabled = modelGateFeatures.oidc;

  const [rows, setRows] = useState<UserRow[]>([]);
  const [form, setForm] = useState<UserForm>(initialForm);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingOidc, setEditingOidc] = useState<UserOidcBinding | null>(null);
  const [editingGroupLimits, setEditingGroupLimits] = useState<UserGroupLimits | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [sortBy, setSortBy] = useState<UserSortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [aliasOptions, setAliasOptions] = useState<AliasOption[]>([]);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);

  function applyUsersData(
    data: UsersListResponse,
    nextPage: number,
    nextSortBy: UserSortKey,
    nextSortDir: SortDirection,
  ) {
    setRows(data.data ?? []);
    setTotal(data.paging?.total ?? 0);
    setPage(nextPage);
    setSortBy((data.sorting?.sort_by as UserSortKey) ?? nextSortBy);
    setSortDir((data.sorting?.sort_dir as SortDirection) ?? nextSortDir);
  }

  async function loadUsers(
    nextPage = page,
    nextKeyword = keyword,
    nextSortBy = sortBy,
    nextSortDir = sortDir,
    nextGroupFilter = groupFilter,
    nextRoleFilter = roleFilter,
  ) {
    if (!(await ensureAdmin(router))) return;
    const offset = (nextPage - 1) * PAGE_SIZE;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort_by: nextSortBy,
      sort_dir: nextSortDir,
    });
    if (nextKeyword.trim()) params.set("keyword", nextKeyword.trim());
    if (nextGroupFilter && nextGroupFilter !== "all") params.set("group_id", nextGroupFilter);
    if (nextRoleFilter && nextRoleFilter !== "all") params.set("role", nextRoleFilter);

    const response = await authedFetch(`/api/admin/users?${params.toString()}`);
    const data = (await response.json()) as UsersListResponse;
    if (response.ok) {
      applyUsersData(data, nextPage, nextSortBy, nextSortDir);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const profile = await ensureAdmin(router);
      if (cancelled || !profile) return;

      const [usersRes, modelsRes, groupsRes] = await Promise.all([
        authedFetch(`/api/admin/users?${new URLSearchParams({ limit: String(PAGE_SIZE), offset: "0", sort_by: "created_at", sort_dir: "desc" })}`),
        authedFetch("/api/admin/models"),
        authedFetch("/api/admin/groups"),
      ]);
      if (cancelled) return;

      const usersData = (await usersRes.json()) as UsersListResponse;
      if (cancelled) return;
      if (usersRes.ok) {
        applyUsersData(usersData, 1, "created_at", "desc");
      }

      const modelsData = await modelsRes.json().catch(() => null);
      if (cancelled) return;
      if (modelsRes.ok) {
        const modelRows = Array.isArray(modelsData?.data) ? (modelsData.data as AliasOption[]) : [];
        const unique = new Map<string, AliasOption>();
        for (const row of modelRows) {
          if (row.is_public === 1) continue;
          if (!unique.has(row.alias)) {
            unique.set(row.alias, row);
          }
        }
        setAliasOptions([...unique.values()].sort((a, b) => a.alias.localeCompare(b.alias)));
      }

      const groupsData = await groupsRes.json().catch(() => null);
      if (cancelled) return;
      if (groupsRes.ok) {
        setGroupOptions(Array.isArray(groupsData?.data) ? groupsData.data : []);
      }
    }
    void init();
    return () => { cancelled = true; };
  }, [router]);

  function updateForm(patch: Partial<UserForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function openCreateUser() {
    setEditingId(null);
    setEditingOidc(null);
    setEditingGroupLimits(null);
    setForm(initialForm);
    setDrawerOpen(true);
  }

  function openEditUser(row: UserRow) {
    setEditingId(row.id);
    setEditingOidc(oidcFeatureEnabled && row.oidc_subject ? { issuer: row.oidc_issuer ?? "", subject: row.oidc_subject } : null);
    setEditingGroupLimits(pickGroupLimits(row));
    setForm(buildUserForm(row));
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

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildUserPayload(form, periodQuotaEnabled);

    if (editingId === null) {
      const response = await authedFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...payload, password: form.password }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "创建用户成功。") });
        setDrawerOpen(false);
        setForm(initialForm);
        await loadUsers(page);
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "创建用户失败。") });
      return;
    }

    const response = await authedFetch(`/api/admin/users/${editingId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "更新用户成功。") });
      setDrawerOpen(false);
      setEditingId(null);
      setForm(initialForm);
      await loadUsers(page);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "更新用户失败。") });
  }

  async function resetUsage(id: number, type: ResetUsageType) {
    const response = await authedFetch(`/api/admin/users/${id}`, {
      method: "PUT",
      body: JSON.stringify({ reset_usage: type }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "用量已重置。") });
      await loadUsers(page);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "重置失败。") });
  }

  async function removeUser(id: number) {
    const response = await authedFetch(`/api/admin/users/${id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除用户成功。") });
      const nextPage = rows.length === 1 && page > 1 ? page - 1 : page;
      await loadUsers(nextPage);
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "删除用户失败。") });
  }

  function searchUsers() {
    void loadUsers(1, keyword, sortBy, sortDir, groupFilter, roleFilter);
  }

  function selectGroupFilter(value: string) {
    setGroupFilter(value);
    void loadUsers(1, keyword, sortBy, sortDir, value, roleFilter);
  }

  function selectRoleFilter(value: string) {
    setRoleFilter(value);
    void loadUsers(1, keyword, sortBy, sortDir, groupFilter, value);
  }

  function resetFilters() {
    setKeyword("");
    setGroupFilter("all");
    setRoleFilter("all");
    setSortBy("created_at");
    setSortDir("desc");
    void loadUsers(1, "", "created_at", "desc", "all", "all");
  }

  return {
    rows,
    form,
    updateForm,
    drawerOpen,
    setDrawerOpen,
    editingId,
    editingOidc,
    editingGroupLimits,
    page,
    total,
    pageSize: PAGE_SIZE,
    keyword,
    setKeyword,
    groupFilter,
    selectGroupFilter,
    roleFilter,
    selectRoleFilter,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    aliasOptions,
    groupOptions,
    periodQuotaEnabled,
    oidcFeatureEnabled,
    loadUsers,
    searchUsers,
    resetFilters,
    openCreateUser,
    openEditUser,
    toggleAllowedAlias,
    submitUser,
    resetUsage,
    removeUser,
  };
}
