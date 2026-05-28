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
import { GroupBasicFields } from "./group-basic-fields";
import { GroupModelAccessFields } from "./group-model-access-fields";
import { GroupQuotaFields } from "./group-quota-fields";
import type { AliasOption, ChannelOption, GroupForm } from "./group-model";

type GroupDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: number | null;
  form: GroupForm;
  aliasOptions: AliasOption[];
  channelOptions: ChannelOption[];
  oidcFeatureEnabled: boolean;
  periodQuotaEnabled: boolean;
  onFormChange: (patch: Partial<GroupForm>) => void;
  onToggleAllowedAlias: (alias: string) => void;
  onToggleAllowedChannel: (channelId: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export function GroupDrawer({
  open,
  onOpenChange,
  editingId,
  form,
  aliasOptions,
  channelOptions,
  oidcFeatureEnabled,
  periodQuotaEnabled,
  onFormChange,
  onToggleAllowedAlias,
  onToggleAllowedChannel,
  onSubmit,
}: GroupDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{editingId === null ? "新增用户组" : `编辑用户组 #${editingId}`}</SheetTitle>
          <SheetDescription>{editingId === null ? "创建新用户组并配置限流与模型白名单。" : "修改组的限速、配额与模型访问权限。"}</SheetDescription>
        </SheetHeader>
        <form onSubmit={(event) => { void onSubmit(event); }} className="mt-4 space-y-4 overflow-y-auto pr-1">
          <GroupBasicFields
            form={form}
            oidcFeatureEnabled={oidcFeatureEnabled}
            onChange={onFormChange}
          />
          <GroupQuotaFields
            form={form}
            periodQuotaEnabled={periodQuotaEnabled}
            onChange={onFormChange}
          />
          <GroupModelAccessFields
            form={form}
            aliasOptions={aliasOptions}
            channelOptions={channelOptions}
            onToggleAllowedAlias={onToggleAllowedAlias}
            onToggleAllowedChannel={onToggleAllowedChannel}
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
