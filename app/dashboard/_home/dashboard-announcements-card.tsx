"use client";

import { useCallback, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Megaphone, Pin } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { authedFetch } from "@/lib/auth/client-auth";

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "ul", "ol", "li", "a", "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "del", "s", "sub", "sup"],
  ALLOWED_ATTR: ["href", "title", "class"],
};

type Announcement = {
  id: number;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
};

function formatDate(value: string) {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function DashboardAnnouncementsCard() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [htmlMap, setHtmlMap] = useState<Record<number, string>>({});

  const fetchAnnouncements = useCallback(async () => {
    try {
      const response = await authedFetch("/api/dashboard/announcements");
      if (!response.ok) return;
      const data = await response.json();
      const list: Announcement[] = data?.data ?? [];
      setAnnouncements(list);

      const rendered: Record<number, string> = {};
      for (const item of list) {
        const html = DOMPurify.sanitize(await marked.parse(item.content), PURIFY_CONFIG);
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

  if (announcements.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="系统公告"
          description="最近发布的通知与公告。"
          action={<Megaphone className="h-5 w-5 text-[var(--color-foreground-muted)]" />}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {announcements.map((item) => (
          <div key={item.id} className="border-b border-[var(--color-border)] pb-4 last:border-b-0 last:pb-0">
            <div className="mb-2 flex items-center gap-2">
              {item.pinned ? (
                <Pin className="h-4 w-4 text-[var(--color-accent)]" />
              ) : null}
              <h3 className="text-base font-semibold text-[var(--color-foreground)]">{item.title}</h3>
              <span className="ml-auto text-xs text-[var(--color-foreground-muted)]">
                {formatDate(item.created_at)}
              </span>
            </div>
            <div
              className="markdown-body text-sm"
              dangerouslySetInnerHTML={{ __html: htmlMap[item.id] ?? "" }}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
