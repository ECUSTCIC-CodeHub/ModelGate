"use client";

import { SectionTitle } from "@/components/dashboard/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AppearanceSettingsCard({
  logoUrl,
  wallpaperUrl,
  setLogoUrl,
  setWallpaperUrl,
}: {
  logoUrl: string;
  wallpaperUrl: string;
  setLogoUrl: (value: string) => void;
  setWallpaperUrl: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <SectionTitle
          title="外观定制"
          description="自定义侧栏 Logo 和全站背景壁纸。留空则不显示对应元素。"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Logo 地址</Label>
          <Input
            placeholder="https://example.com/logo.svg"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">侧栏及移动端导航左上角展示的 Logo 图片地址。留空则不显示 Logo。</p>
        </div>
        <div className="space-y-2">
          <Label>壁纸地址</Label>
          <Input
            placeholder="https://example.com/api/wallpaper"
            value={wallpaperUrl}
            onChange={(e) => setWallpaperUrl(e.target.value)}
          />
          <p className="text-xs text-[var(--color-foreground-muted)]">全站背景壁纸图片地址。支持返回图片的任意 URL（含 302 跳转）。</p>
        </div>
      </CardContent>
    </Card>
  );
}
