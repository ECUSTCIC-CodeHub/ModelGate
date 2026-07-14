"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { SectionTitle } from "@/components/dashboard/section-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiMessage } from "@/lib/shared/api-message";
import { authedFetch } from "@/lib/auth/client-auth";

type GroupOption = { id: number; name: string; user_count: number };

export function BroadcastEmailCard() {
  const { toast } = useToast();
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [target, setTarget] = useState("all");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await authedFetch("/api/admin/groups?limit=200");
      const data = await res.json().catch(() => null);
      if (!cancelled && res.ok) {
        setGroups((data?.data ?? []) as GroupOption[]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSend() {
    if (!title.trim()) {
      toast({ variant: "error", description: "请填写邮件标题。" });
      return;
    }
    if (!content.trim()) {
      toast({ variant: "error", description: "请填写邮件正文。" });
      return;
    }
    const scopeText =
      target === "all"
        ? "全部有邮箱的有效用户"
        : `用户组「${groups.find((g) => String(g.id) === target)?.name ?? target}」的成员`;
    if (!window.confirm(`确认向${scopeText}发送这封邮件？`)) return;

    setSending(true);
    try {
      const response = await authedFetch("/api/admin/email/send", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          target: target === "all" ? "all" : "group",
          group_id: target === "all" ? null : Number(target),
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        toast({ variant: "success", description: getApiMessage(data, "广播邮件已提交，将在后台发送。") });
        setTitle("");
        setContent("");
      } else {
        toast({ variant: "error", description: getApiMessage(data, "提交失败。") });
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="发送邮件"
          description="向全部用户或指定用户组主动发送一封邮件通知，不经过系统公告。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>收件范围</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue placeholder="选择收件范围" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部用户</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>
                  {g.name}（{g.user_count} 人）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>邮件标题</Label>
          <Input
            placeholder="邮件标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
          />
        </div>

        <div className="space-y-2">
          <Label>邮件正文</Label>
          <textarea
            className="flex min-h-32 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm text-[var(--color-foreground)] shadow-[var(--shadow-inner-highlight)] placeholder:text-[var(--color-foreground-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20"
            placeholder="支持 Markdown 格式"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={20000}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">
            邮件分页与页脚沿用「邮件通知」中的设置。
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void handleSend()} disabled={sending}>
            <Send className="h-4 w-4" />
            {sending ? "发送中" : "发送邮件"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
