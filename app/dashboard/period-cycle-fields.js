"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { PERIOD_PRESETS } from "@/lib/shared/period-format";
export function newCycleDraft(preset = "") {
    return {
        key: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        preset,
        custom: "",
        quota_tokens: "",
        quota_requests: "",
    };
}
export function draftSeconds(draft) {
    if (draft.preset === "custom") {
        const value = Number(draft.custom.trim());
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    }
    if (!draft.preset)
        return null;
    const value = Number(draft.preset);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
// 草稿 → 提交体。秒数非法或额度非法的档位跳过；两项额度都留空的档位保留，
// 语义是「该周期继承上游」（无上游即不限制），与后端校验口径一致。
// 额度填 -1 表示显式不限制。
export function draftsToPayload(drafts) {
    const out = [];
    const seen = new Set();
    for (const draft of drafts) {
        const seconds = draftSeconds(draft);
        if (seconds === null || seen.has(seconds))
            continue;
        const tokens = parseQuotaInput(draft.quota_tokens);
        const requests = parseQuotaInput(draft.quota_requests);
        if (tokens === undefined || requests === undefined)
            continue;
        seen.add(seconds);
        out.push({ seconds, quota_tokens: tokens, quota_requests: requests });
    }
    return out;
}
// 额度输入：空串 → null（继承），-1 → -1（不限制），非负整数 → 数值。
// 其余输入返回 undefined，由调用方丢弃该档位。
function parseQuotaInput(raw) {
    const trimmed = raw.trim();
    if (trimmed === "")
        return null;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < -1)
        return undefined;
    return value;
}
// 已存周期 → 草稿。用于编辑回填。
export function cyclesToDrafts(cycles) {
    return cycles.map((cycle) => {
        const preset = PERIOD_PRESETS.some((item) => Number(item.value) === cycle.seconds) ? String(cycle.seconds) : "custom";
        return {
            key: `c${cycle.seconds}`,
            preset,
            custom: preset === "custom" ? String(cycle.seconds) : "",
            quota_tokens: cycle.quota_tokens === null ? "" : String(cycle.quota_tokens),
            quota_requests: cycle.quota_requests === null ? "" : String(cycle.quota_requests),
        };
    });
}
export function PeriodCycleFields({ drafts, onChange, hint, customPlaceholder = "如 7200 = 2 小时", inheritedHint = "留空表示继承上游，无上游则不限制；填 -1 表示显式不限制。", }) {
    const update = (key, patch) => {
        onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    };
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-[var(--color-foreground)]", children: "\u5468\u671F\u914D\u989D" }), _jsx("p", { className: "text-xs text-[var(--color-foreground-muted)]", children: hint ?? "可同时配置多个重置周期，任一周期超出即拒绝请求。留空表示继承上游，填 -1 表示不限制。" })] }), drafts.length === 0 ? (_jsx("p", { className: "text-xs text-[var(--color-foreground-muted)]", children: "\u672A\u914D\u7F6E\u5468\u671F\u914D\u989D\u3002" })) : null, drafts.map((draft) => (_jsxs("div", { className: "grid gap-3 rounded-lg border border-[var(--color-border)] p-3 md:grid-cols-2", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u91CD\u7F6E\u5468\u671F" }), _jsxs(Select, { value: draft.preset || "none", onValueChange: (value) => update(draft.key, {
                                    preset: value === "none" ? "" : value,
                                    custom: value === "custom" ? draft.custom : "",
                                }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "\u672A\u9009\u62E9" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "none", children: "\u672A\u9009\u62E9" }), PERIOD_PRESETS.map((preset) => (_jsx(SelectItem, { value: preset.value, children: preset.label }, preset.value))), _jsx(SelectItem, { value: "custom", children: "\u81EA\u5B9A\u4E49" })] })] })] }), draft.preset === "custom" ? (_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u81EA\u5B9A\u4E49\u5468\u671F\uFF08\u79D2\uFF09" }), _jsx(Input, { type: "number", min: 60, value: draft.custom, onChange: (e) => update(draft.key, { custom: e.target.value }), placeholder: customPlaceholder })] })) : _jsx("div", {}), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u5468\u671F\u8BF7\u6C42\u914D\u989D" }), _jsx(Input, { type: "number", min: -1, value: draft.quota_requests, onChange: (e) => update(draft.key, { quota_requests: e.target.value }), placeholder: "\u7559\u7A7A\u7EE7\u627F\uFF0C-1 \u4E0D\u9650\u5236" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "\u5468\u671F Token \u914D\u989D" }), _jsx(Input, { type: "number", min: -1, value: draft.quota_tokens, onChange: (e) => update(draft.key, { quota_tokens: e.target.value }), placeholder: "\u7559\u7A7A\u7EE7\u627F\uFF0C-1 \u4E0D\u9650\u5236" })] }), draft.quota_requests.trim() === "" && draft.quota_tokens.trim() === "" ? (_jsx("p", { className: "text-xs text-[var(--color-foreground-muted)] md:col-span-2", children: inheritedHint })) : null, _jsx("div", { className: "md:col-span-2", children: _jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: () => onChange(drafts.filter((item) => item.key !== draft.key)), children: "\u79FB\u9664\u8BE5\u5468\u671F" }) })] }, draft.key))), _jsx(Button, { type: "button", variant: "outline", size: "sm", disabled: drafts.length >= 8, onClick: () => onChange([...drafts, newCycleDraft()]), children: "\u6DFB\u52A0\u91CD\u7F6E\u5468\u671F" })] }));
}
