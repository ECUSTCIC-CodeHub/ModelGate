"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function SaveSettingsCard({ onSave }: { onSave: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-end p-5">
        <Button onClick={onSave}>保存设置</Button>
      </CardContent>
    </Card>
  );
}
