"use client";

import { useCallback, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ChevronDown, Megaphone, Pin } from "lucide-react";
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
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">系统公告</h2>
          <Megaphone className="hidden h-4 w-4 text-[var(--color-foreground-muted)] md:block" />
        </div>
      </CardHeader>
      <CardContent className="grid gap-0 md:grid-cols-2">
        {announcements.map((item) => {
          const expanded = expandedIds.has(item.id);
          return (
            <div key={item.id} className="border-b border-[var(--color-border)] py-1 last:border-b-0 md:[&:nth-child(odd)]:border-r">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`announcement-content-${item.id}`}
                onClick={() => toggleExpand(item.id)}
                className="flex w-full items-center gap-1.5 py-1.5 text-left"
              >
                {item.pinned ? (
                  <Pin className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                ) : null}
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 text-[var(--color-foreground-muted)] transition-transform ${expanded ? "rotate-180" : ""}`}
                />
                <h3 className="truncate text-sm font-medium text-[var(--color-foreground)]">{item.title}</h3>
                <span className="ml-auto shrink-0 text-xs text-[var(--color-foreground-muted)]">
                  {formatAnnouncementDate(item.created_at)}
                </span>
              </button>
              {expanded ? (
                <div
                  id={`announcement-content-${item.id}`}
                  className="markdown-body pb-2 text-xs"
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
