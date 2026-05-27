"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PasswordDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPassword: string;
  newPassword: string;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSubmit: () => void;
};

export function PasswordDialog({
  open,
  onOpenChange,
  currentPassword,
  newPassword,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onSubmit,
}: PasswordDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>更新当前账号密码，不会影响现有 Token 与权限配置。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shell_current_password">当前密码</Label>
            <Input
              id="shell_current_password"
              type="password"
              value={currentPassword}
              onChange={(event) => onCurrentPasswordChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shell_new_password">新密码</Label>
            <Input
              id="shell_new_password"
              type="password"
              value={newPassword}
              onChange={(event) => onNewPasswordChange(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={onSubmit}>更新密码</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
