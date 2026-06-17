"use client";

import { useCallback, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ChevronDown, Megaphone, Pin } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { authedFetch } from "@/lib/auth/client-auth";
import { formatAnnouncementDate, MARKDOWN_PURIFY_CONFIG } from "@/lib/shared/utils";

type Announcement = {
  id: number;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
};

export function DashboardAnnouncementsCard() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [htmlMap, setHtmlMap] = useState<Record<number, string>>({});
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const fetchAnnouncements = useCallback(async () => {
    try {
      const response = await authedFetch("/api/dashboard/announcements");
      if (!response.ok) return;
      const data = await response.json();
      const list: Announcement[] = data?.data ?? [];
      setAnnouncements(list);

      const rendered: Record<number, string> = {};
      for (const item of list) {
        const html = DOMPurify.sanitize(await marked.parse(item.content), MARKDOWN_PURIFY_CONFIG);
        rendered[item.id] = html;
      }
      setHtmlMap(rendered);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    void fetchAnnouncements();
  }, [fetchAnnouncements]);

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (announcements.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="系统公告"
          description="最近发布的通知与公告，点击标题展开查看。"
          action={<Megaphone className="h-5 w-5 text-[var(--color-foreground-muted)]" />}
        />
      </CardHeader>
      <CardContent className="space-y-1">
        {announcements.map((item) => {
          const expanded = expandedIds.has(item.id);
          return (
            <div key={item.id} className="border-b border-[var(--color-border)] last:border-b-0">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`announcement-content-${item.id}`}
                onClick={() => toggleExpand(item.id)}
                className="flex w-full items-center gap-2 py-3 text-left"
              >
                {item.pinned ? (
                  <Pin className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                ) : null}
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-[var(--color-foreground-muted)] transition-transform ${expanded ? "rotate-180" : ""}`}
                />
                <h3 className="truncate text-base font-semibold text-[var(--color-foreground)]">{item.title}</h3>
                <span className="ml-auto shrink-0 text-xs text-[var(--color-foreground-muted)]">
                  {formatAnnouncementDate(item.created_at)}
                </span>
              </button>
              {expanded ? (
                <div
                  id={`announcement-content-${item.id}`}
                  className="markdown-body pb-4 text-sm"
                  dangerouslySetInnerHTML={{ __html: htmlMap[item.id] ?? "" }}
                />
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
