"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatAnnouncementDate } from "@/lib/shared/utils";

type Announcement = {
  id: number;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
};

export function AnnouncementSettingsCard({
  announcementDisplayCount,
  setAnnouncementDisplayCount,
}: {
  announcementDisplayCount: number;
  setAnnouncementDisplayCount: (value: number) => void;
}) {
  const { toast } = useToast();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formPinned, setFormPinned] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchAnnouncements = useCallback(async () => {
    try {
      const response = await authedFetch("/api/admin/announcements");
      if (!response.ok) return;
      const data = await response.json();
      setAnnouncements(data?.data ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAnnouncements();
  }, [fetchAnnouncements]);

  function resetForm() {
    setFormTitle("");
    setFormContent("");
    setFormPinned(false);
    setEditingId(null);
    setShowForm(false);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  function startEdit(item: Announcement) {
    setFormTitle(item.title);
    setFormContent(item.content);
    setFormPinned(item.pinned === 1);
    setEditingId(item.id);
    setShowForm(true);
  }

  async function submitForm() {
    if (!formTitle.trim() || !formContent.trim()) {
      toast({ variant: "error", description: "标题和内容不能为空。" });
      return;
    }
    setSubmitting(true);
    try {
      const isEdit = editingId !== null;
      const url = isEdit ? `/api/admin/announcements/${editingId}` : "/api/admin/announcements";
      const method = isEdit ? "PUT" : "POST";
      const body: Record<string, unknown> = {
        title: formTitle.trim(),
        content: formContent.trim(),
        pinned: formPinned,
      };
      const response = await authedFetch(url, { method, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, isEdit ? "更新成功。" : "创建成功。") });
        resetForm();
        await fetchAnnouncements();
        return;
      }
      toast({ variant: "error", description: getApiMessage(data, "操作失败。") });
    } finally {
      setSubmitting(false);
    }
  }

  async function togglePin(item: Announcement) {
    const response = await authedFetch(`/api/admin/announcements/${item.id}`, {
      method: "PUT",
      body: JSON.stringify({ pinned: item.pinned !== 1 }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "操作成功。") });
      await fetchAnnouncements();
    } else {
      toast({ variant: "error", description: getApiMessage(data, "操作失败。") });
    }
  }

  async function deleteAnnouncement(item: Announcement) {
    const response = await authedFetch(`/api/admin/announcements/${item.id}`, { method: "DELETE" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "删除成功。") });
      await fetchAnnouncements();
    } else {
      toast({ variant: "error", description: getApiMessage(data, "删除失败。") });
    }
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="公告管理"
          description="管理用户可见的系统公告，支持新增、删除和置顶。每条公告独立存储，前台按发布时间倒序展示。"
          action={
            <Button onClick={startCreate} disabled={showForm}>
              <Plus className="h-4 w-4" />
              新增公告
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--color-foreground-muted)]">首页展示条数</label>
          <input
            type="number"
            min={1}
            max={20}
            value={announcementDisplayCount}
            onChange={(e) => setAnnouncementDisplayCount(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
            className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-1.5 text-sm text-[var(--color-foreground)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
          />
          <span className="text-xs text-[var(--color-foreground-muted)]">首页概览展示最近 N 条公告，保存设置后生效。</span>
        </div>

        {showForm ? (
          <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
            <div className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-[var(--color-foreground-muted)]" />
              <span className="text-sm font-medium text-[var(--color-foreground)]">
                {editingId !== null ? "编辑公告" : "新增公告"}
              </span>
            </div>
            <input
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
              placeholder="公告标题"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              maxLength={255}
            />
            <textarea
              className="flex min-h-32 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
              placeholder={"支持 Markdown，例如：\n公告正文内容..."}
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              maxLength={10000}
            />
            <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
              <input
                type="checkbox"
                checked={formPinned}
                onChange={(e) => setFormPinned(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--color-border)]"
              />
              置顶（展示时排在最前面）
            </label>
            <div className="flex gap-2">
              <Button onClick={() => void submitForm()} disabled={submitting}>
                {editingId !== null ? "保存" : "创建"}
              </Button>
              <Button variant="outline" onClick={resetForm} disabled={submitting}>
                取消
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">
            加载中...
          </div>
        ) : announcements.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-foreground-muted)]">
            暂无公告，点击「新增公告」创建第一条。
          </div>
        ) : (
          <div className="space-y-2">
            {announcements.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {item.pinned === 1 ? (
                      <Pin className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                    ) : null}
                    <span className="truncate font-medium text-[var(--color-foreground)]">{item.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-[var(--color-foreground-muted)]">
                      {formatAnnouncementDate(item.created_at, true)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--color-foreground-muted)]">
                    {item.content}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void togglePin(item)}
                    title={item.pinned === 1 ? "取消置顶" : "置顶"}
                  >
                    {item.pinned === 1 ? (
                      <PinOff className="h-4 w-4" />
                    ) : (
                      <Pin className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(item)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void deleteAnnouncement(item)}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
