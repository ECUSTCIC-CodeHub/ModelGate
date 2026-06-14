"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function SaveSettingsCard({ disabled, onSave }: { disabled?: boolean; onSave: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-end p-5">
        <Button disabled={disabled} onClick={onSave}>{disabled ? "保存中..." : "保存设置"}</Button>
      </CardContent>
    </Card>
  );
}
