"use client";

import { useEffect, useState } from "react";
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

const DISMISSED_KEY = "announcement_dismissed_hash";

async function hashContent(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function AnnouncementDialog() {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState("");
  const [contentHash, setContentHash] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await authedFetch("/api/dashboard/announcement");
        if (!response.ok) return;
        const data = await response.json();
        const content = (data?.content ?? "").trim();
        if (!content) return;

        const hash = await hashContent(content);
        if (localStorage.getItem(DISMISSED_KEY) === hash) return;

        setContentHash(hash);
        const rendered = await marked.parse(content);
        setHtml(DOMPurify.sanitize(rendered));
        setOpen(true);
      } catch {
        // silently ignore
      }
    })();
  }, []);

  function onDismiss() {
    setOpen(false);
    if (contentHash) {
      localStorage.setItem(DISMISSED_KEY, contentHash);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDismiss(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>系统公告</DialogTitle>
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
