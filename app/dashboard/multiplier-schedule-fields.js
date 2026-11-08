"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export const WEEKDAY_OPTIONS = [
    { value: 1, label: "一" },
    { value: 2, label: "二" },
    { value: 3, label: "三" },
    { value: 4, label: "四" },
    { value: 5, label: "五" },
    { value: 6, label: "六" },
    { value: 7, label: "日" },
];
export function newScheduleDraft() {
    return {
        key: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        days: [1, 2, 3, 4, 5, 6, 7],
        start: "00:00",
        end: "08:00",
        token_multiplier: "",
        request_multiplier: "",
    };
}
export function scheduleDraftsToPayload(drafts) {
    const out = [];
    for (const draft of drafts) {
        if (draft.days.length === 0)
            continue;
        const tokens = draft.token_multiplier.trim() === "" ? null : Number(draft.token_multiplier);
        const requests = draft.request_multiplier.trim() === "" ? null : Number(draft.request_multiplier);
        if (tokens === null && requests === null)
            continue;
        out.push({
            days: draft.days,
            start: draft.start,
            end: draft.end,
            token_multiplier: tokens,
            request_multiplier: requests,
        });
    }
    return out;
}
export function schedulesToDrafts(schedules) {
    return schedules.map((schedule, index) => ({
        key: `s${index}`,
        days: schedule.days,
        start: schedule.start,
        end: schedule.end,
        token_multiplier: schedule.token_multiplier === null ? "" : String(schedule.token_multiplier),
        request_multiplier: schedule.request_multiplier === null ? "" : String(schedule.request_multiplier),
    }));
}
export function MultiplierScheduleFields({ drafts, onChange, baseTokenMultiplier, baseRequestMultiplier, }) {
    const update = (key, patch) => {
        onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    };
    const toggleDay = (key, day) => {
        const draft = drafts.find((item) => item.key === key);
        if (!draft)
            return;
        const days = draft.days.includes(day)
            ? draft.days.filter((value) => value !== day)
            : [...draft.days, day].sort((a, b) => a - b);
        update(key, { days });
    };
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-[var(--color-foreground)]", children: "\u5206\u65F6\u500D\u7387" }), _jsxs("p", { className: "text-xs text-[var(--color-foreground-muted)]", children: ["\u547D\u4E2D\u65F6\u6BB5\u7684\u8BF7\u6C42\u6309\u8BE5\u6863\u500D\u7387\u8BA1\u8D39\uFF0C\u672A\u547D\u4E2D\u65F6\u6BB5\u6CBF\u7528\u4E0A\u65B9\u57FA\u7840\u500D\u7387\uFF08", baseTokenMultiplier, "x / ", baseRequestMultiplier, "x\uFF09\u3002\u65F6\u6BB5\u65F6\u95F4\u6309 UTC \u89E3\u91CA\uFF0C\u53EF\u8DE8\u96F6\u70B9\uFF1B\u591A\u6863\u540C\u65F6\u547D\u4E2D\u65F6\u6309\u4ECE\u4E0A\u5230\u4E0B\u7684\u987A\u5E8F\u53D6\u7B2C\u4E00\u6863\u3002\u7559\u7A7A\u7684\u7EF4\u5EA6\u6CBF\u7528\u57FA\u7840\u500D\u7387\u3002"] })] }), drafts.length === 0 ? (_jsx("p", { className: "text-xs text-[var(--color-foreground-muted)]", children: "\u672A\u914D\u7F6E\u5206\u65F6\u500D\u7387\uFF0C\u5168\u90E8\u8BF7\u6C42\u4F7F\u7528\u57FA\u7840\u500D\u7387\u3002" })) : null, drafts.map((draft) => (_jsxs("div", { className: "space-y-3 rounded-lg border border-[var(--color-border)] p-3", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u751F\u6548\u661F\u671F" }), _jsx("div", { className: "flex flex-wrap gap-1", children: WEEKDAY_OPTIONS.map((option) => (_jsx(Button, { type: "button", size: "sm", variant: draft.days.includes(option.value) ? "default" : "outline", onClick: () => toggleDay(draft.key, option.value), children: option.label }, option.value))) })] }), _jsxs("div", { className: "grid gap-3 md:grid-cols-2", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u5F00\u59CB\u65F6\u95F4\uFF08UTC\uFF0CHH:MM\uFF09" }), _jsx(Input, { type: "time", value: draft.start, onChange: (e) => update(draft.key, { start: e.target.value }) })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u7ED3\u675F\u65F6\u95F4\uFF08UTC\uFF0CHH:MM\uFF09" }), _jsx(Input, { type: "time", value: draft.end, onChange: (e) => update(draft.key, { end: e.target.value }) })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Token \u500D\u7387" }), _jsx(Input, { type: "number", min: 0, step: 0.1, value: draft.token_multiplier, onChange: (e) => update(draft.key, { token_multiplier: e.target.value }), placeholder: "\u7559\u7A7A\u6CBF\u7528\u57FA\u7840\u500D\u7387" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u8BF7\u6C42\u500D\u7387" }), _jsx(Input, { type: "number", min: 0, step: 0.1, value: draft.request_multiplier, onChange: (e) => update(draft.key, { request_multiplier: e.target.value }), placeholder: "\u7559\u7A7A\u6CBF\u7528\u57FA\u7840\u500D\u7387" })] })] }), _jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onChange(drafts.filter((item) => item.key !== draft.key)), children: "\u79FB\u9664\u8BE5\u65F6\u6BB5" })] }, draft.key))), _jsx(Button, { type: "button", variant: "outline", size: "sm", disabled: drafts.length >= 20, onClick: () => onChange([...drafts, newScheduleDraft()]), children: "\u6DFB\u52A0\u65F6\u6BB5" })] }));
}
