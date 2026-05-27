"use client";

import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

type DashboardHeaderActionsProps = {
  onNavigate: (href: string) => void;
};

export function DashboardHeaderActions({ onNavigate }: DashboardHeaderActionsProps) {
  return (
    <>
      <Button variant="outline" onClick={() => onNavigate("/dashboard/logs")}>查看日志</Button>
      <Button onClick={() => onNavigate("/dashboard/keys")}>
        <KeyRound className="h-4 w-4" />
        管理密钥
      </Button>
    </>
  );
}
