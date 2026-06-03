"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthProfile } from "@/components/providers/auth-provider";
import { authedFetch, ensureLoggedIn, getCachedProfile } from "@/lib/auth/client-auth";
import {
  emptyLogFilters,
  type LogFilters,
  type LogRole,
  type LogRow,
  type LogStatusFilter,
  type LogSummary,
} from "./log-model";

const PAGE_SIZE = 20;

type LogsResponse = {
  data?: LogRow[];
  summary?: LogSummary;
  paging?: { total?: number };
};

function parseStatusFilter(value: string | null): LogStatusFilter {
  if (value === "failed") return "failed";
  if (value === "success") return "success";
  return "all";
}

function buildLogParams(role: LogRole, page: number, filters: LogFilters) {
  const offset = (page - 1) * PAGE_SIZE;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (role === "admin" && filters.user.trim()) params.set("user", filters.user.trim());
  if (filters.model.trim()) params.set("model", filters.model.trim());
  if (role === "admin" && filters.channel.trim()) params.set("channel", filters.channel.trim());
  if (filters.key.trim()) params.set("key", filters.key.trim());
  if (filters.ip.trim()) params.set("ip", filters.ip.trim());
  if (filters.startDate) params.set("start_date", filters.startDate);
  if (filters.endDate) params.set("end_date", filters.endDate);
  if (filters.status !== "all") params.set("status", filters.status);
  return params;
}

export function useLogAdmin() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProfile = useAuthProfile();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<LogRole>(() => initialProfile?.role ?? getCachedProfile()?.role ?? "user");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<LogFilters>(() => ({
    ...emptyLogFilters,
    status: parseStatusFilter(searchParams.get("status")),
  }));
  const loadSeqRef = useRef(0);

  async function loadLogs(nextPage = page, nextFilters = filters) {
    const requestSeq = ++loadSeqRef.current;
    setLoading(true);

    const profile = await ensureLoggedIn(router);
    if (requestSeq !== loadSeqRef.current) return;
    if (!profile) return;
    const nextRole = profile.role as LogRole;
    setRole(nextRole);

    const params = buildLogParams(nextRole, nextPage, nextFilters);
    const response = await authedFetch(`/api/dashboard/logs?${params.toString()}`);
    if (requestSeq !== loadSeqRef.current) return;
    if (!response.ok) {
      setLoading(false);
      return;
    }
    const data = (await response.json()) as LogsResponse;
    if (requestSeq !== loadSeqRef.current) return;
    setRows(data.data ?? []);
    setSummary(data.summary ?? null);
    setTotal(data.paging?.total ?? 0);
    setPage(nextPage);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const requestSeq = ++loadSeqRef.current;
      setLoading(true);

      const profile = await ensureLoggedIn(router);
      if (cancelled || requestSeq !== loadSeqRef.current) return;
      if (!profile) return;
      const nextRole = profile.role as LogRole;
      if (cancelled) return;
      setRole(nextRole);

      const initialFilters: LogFilters = {
        ...emptyLogFilters,
        status: parseStatusFilter(searchParams.get("status")),
      };

      const params = buildLogParams(nextRole, 1, initialFilters);
      const response = await authedFetch(`/api/dashboard/logs?${params.toString()}`);
      if (cancelled || requestSeq !== loadSeqRef.current) return;
      if (!response.ok) {
        setLoading(false);
        return;
      }
      const data = (await response.json()) as LogsResponse;
      if (cancelled || requestSeq !== loadSeqRef.current) return;
      setRows(data.data ?? []);
      setSummary(data.summary ?? null);
      setTotal(data.paging?.total ?? 0);
      setPage(1);
      setFilters(initialFilters);
      setLoading(false);
    }
    void init();
    return () => { cancelled = true; };
  }, [router, searchParams]);

  function updateFilters(patch: Partial<LogFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function searchLogs() {
    void loadLogs(1, filters);
  }

  function resetFilters() {
    const nextFilters = { ...emptyLogFilters };
    setFilters(nextFilters);
    void loadLogs(1, nextFilters);
  }

  return {
    rows,
    summary,
    loading,
    role,
    page,
    total,
    pageSize: PAGE_SIZE,
    filters,
    updateFilters,
    loadLogs,
    searchLogs,
    resetFilters,
  };
}
