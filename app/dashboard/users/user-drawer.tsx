"use client";

import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  AliasOption,
  GroupOption,
  UserForm,
  UserGroupLimits,
  UserOidcBinding,
} from "./user-model";
import { UserBasicFields } from "./user-basic-fields";
import { UserModelAccessFields } from "./user-model-access-fields";
import { UserOidcBindingPanel } from "./user-oidc-binding";
import { UserQuotaFields } from "./user-quota-fields";

type UserDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: number | null;
  form: UserForm;
  groupOptions: GroupOption[];
  aliasOptions: AliasOption[];
  oidcFeatureEnabled: boolean;
  periodQuotaEnabled: boolean;
  editingOidc: UserOidcBinding | null;
  editingGroupLimits: UserGroupLimits | null;
  onFormChange: (patch: Partial<UserForm>) => void;
  onToggleAllowedAlias: (alias: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export function UserDrawer({
  open,
  onOpenChange,
  editingId,
  form,
  groupOptions,
  aliasOptions,
  oidcFeatureEnabled,
  periodQuotaEnabled,
  editingOidc,
  editingGroupLimits,
  onFormChange,
  onToggleAllowedAlias,
  onSubmit,
}: UserDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{editingId === null ? "新增用户" : `编辑用户 #${editingId}`}</SheetTitle>
          <SheetDescription>{editingId === null ? "创建新用户账号并设置初始配额。" : "修改角色、限速、配额与模型访问权限。"}</SheetDescription>
        </SheetHeader>
        <form onSubmit={(event) => { void onSubmit(event); }} className="mt-4 space-y-4 overflow-y-auto pr-1">
          <UserBasicFields
            form={form}
            editingId={editingId}
            groupOptions={groupOptions}
            onChange={onFormChange}
          />
          {oidcFeatureEnabled && editingId !== null ? <UserOidcBindingPanel binding={editingOidc} /> : null}
          <UserQuotaFields
            form={form}
            editingGroupLimits={editingGroupLimits}
            periodQuotaEnabled={periodQuotaEnabled}
            onChange={onFormChange}
          />
          <UserModelAccessFields
            form={form}
            aliasOptions={aliasOptions}
            onToggleAllowedAlias={onToggleAllowedAlias}
          />
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit">{editingId === null ? "创建" : "保存"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
