"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * 兑换码展示与复制。
 *
 * `navigator.clipboard` 只在安全上下文（https 或 localhost）存在，而本页也会在
 * 局域网 http 部署下被打开，那里它是 `undefined`。此时退回选中文本 + 旧式
 * `execCommand("copy")`，再不行就明说「请手动选中复制」——按钮停在「已复制」而
 * 实际没复制，用户会以为码已经进剪贴板了。
 */
export function CopyCode({ code }: { code: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback((next: "copied" | "failed") => {
    setStatus(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        flash("copied");
        return;
      }
    } catch {
      // 落到下面的选中方案
    }

    const node = codeRef.current;
    if (node) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
      try {
        if (document.execCommand("copy")) {
          flash("copied");
          return;
        }
      } catch {
        // 继续走失败分支
      }
    }
    flash("failed");
  }, [code, flash]);

  return (
    <div className="space-y-3">
      <div
        ref={codeRef}
        className="select-all rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] text-[var(--color-foreground)]"
      >
        {code}
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={() => void copy()}>
        {status === "copied" ? "已复制" : status === "failed" ? "请手动选中复制" : "复制兑换码"}
      </Button>
    </div>
  );
}
