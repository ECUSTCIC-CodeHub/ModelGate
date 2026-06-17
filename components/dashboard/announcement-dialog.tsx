"use client";

import { useCallback, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { authedFetch } from "@/lib/auth/client-auth";

const DISMISSED_KEY = "announcement_dismissed_id";

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "ul", "ol", "li", "a", "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "del", "s", "sub", "sup"],
  ALLOWED_ATTR: ["href", "title", "class"],
};

export function AnnouncementDialog() {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState("");
  const [title, setTitle] = useState("");
  const [announcementId, setAnnouncementId] = useState<number | null>(null);

  const fetchAndShow = useCallback(async (force = false) => {
    try {
      const response = await authedFetch("/api/dashboard/announcement");
      if (!response.ok) return;
      const data = await response.json();
      const id: number | null = data?.id ?? null;
      const content = (data?.content ?? "").trim();
      if (!content || id === null) return;

      const stored = localStorage.getItem(DISMISSED_KEY);
      if (!force && stored === String(id)) return;

      setAnnouncementId(id);
      setTitle(data?.title || "系统公告");
      const rendered = await marked.parse(content);
      setHtml(DOMPurify.sanitize(rendered, PURIFY_CONFIG));
      setOpen(true);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    void fetchAndShow();
  }, [fetchAndShow]);

  useEffect(() => {
    function onReopen() {
      localStorage.removeItem(DISMISSED_KEY);
      void fetchAndShow(true);
    }
    window.addEventListener("announcement:reopen", onReopen);
    return () => window.removeEventListener("announcement:reopen", onReopen);
  }, [fetchAndShow]);

  function onDismiss() {
    setOpen(false);
    if (announcementId !== null) {
      localStorage.setItem(DISMISSED_KEY, String(announcementId));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDismiss(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title || "系统公告"}</DialogTitle>
          <DialogDescription>来自管理员的通知</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div
            className="markdown-body pr-3"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </ScrollArea>
        <DialogFooter>
          <Button onClick={onDismiss}>我知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
