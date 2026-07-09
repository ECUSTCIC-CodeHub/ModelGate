import { safeRegexTest } from "@/lib/shared/claim-expr";

export type UaRestrictionRule = {
  pattern: string;
  mode: "allow" | "deny";
  error_code: number;
  error_message: string;
};

export type UaRestrictionMatch =
  | { matched: false }
  | { matched: true; allowed: boolean; rule: UaRestrictionRule; source: "global" | "channel" | "model" };

const REGEX_PREFIX = "regex:";
const MAX_PATTERN_LENGTH = 256;
const MAX_RULES = 50;

// 通配符与正则模式均使用 "i" 标志，匹配时自动忽略大小写。
// 即规则 pattern 与客户端 UA 的大小写差异不影响匹配结果。

function isPlainPattern(pattern: string): boolean {
  return !pattern.startsWith(REGEX_PREFIX);
}

// 将通配符转换为正则；结尾 "i" 标志确保匹配忽略大小写。
function wildcardToRegex(pattern: string): RegExp {
  let escaped = "";
  for (const ch of pattern) {
    if (ch === "*") {
      escaped += ".*";
    } else if (".+?^${}()|[]\\".includes(ch)) {
      escaped += "\\" + ch;
    } else {
      escaped += ch;
    }
  }
  return new RegExp(`^${escaped}$`, "i");
}

function compilePattern(pattern: string): RegExp {
  if (isPlainPattern(pattern)) {
    return wildcardToRegex(pattern);
  }
  // regex: 前缀的正则同样强制 "i" 标志，保证整体忽略大小写。
  const raw = pattern.slice(REGEX_PREFIX.length);
  return new RegExp(raw, "i");
}

function ruleMatches(rule: UaRestrictionRule, userAgent: string | null): boolean {
  if (rule.pattern.length === 0 || rule.pattern.length > MAX_PATTERN_LENGTH) return false;
  if (userAgent === null) {
    // 未提供 UA 仅与显式空串模式匹配
    return rule.pattern === "" || rule.pattern === '""';
  }
  try {
    return safeRegexTest(compilePattern(rule.pattern), userAgent);
  } catch {
    return false;
  }
}

export function parseUaRestrictions(raw: string | null | undefined): UaRestrictionRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: UaRestrictionRule[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const pattern = typeof record.pattern === "string" ? record.pattern : "";
    const mode = record.mode === "deny" ? "deny" : "allow";
    const errorCode = Number(record.error_code);
    const errorMessage = typeof record.error_message === "string" && record.error_message.length > 0
      ? record.error_message
      : "客户端 User-Agent 不被允许访问该资源。";
    if (Number.isFinite(errorCode) && errorCode >= 100 && errorCode <= 599) {
      rules.push({ pattern, mode, error_code: Math.trunc(errorCode), error_message: errorMessage });
    }
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

function applyRules(rules: UaRestrictionRule[], userAgent: string | null, source: "global" | "channel" | "model"): UaRestrictionMatch {
  for (const rule of rules) {
    if (ruleMatches(rule, userAgent)) {
      return { matched: true, allowed: rule.mode === "allow", rule, source };
    }
  }
  return { matched: false };
}

/**
 * 按 全站 -> 渠道 -> 模型 优先级校验 UA 限制。
 * - 任何层级命中 deny 立即拦截。
 * - 任何层级配置了规则且命中 allow，则视为该层级放行。
 * - 未命中任何规则时继续下一层级；全部层级均无命中则放行。
 */
export function checkUserAgentRestrictions(params: {
  userAgent: string | null;
  globalRules: UaRestrictionRule[];
  channelRules: UaRestrictionRule[];
  modelRules: UaRestrictionRule[];
}): UaRestrictionMatch {
  const { userAgent, globalRules, channelRules, modelRules } = params;

  if (globalRules.length > 0) {
    const result = applyRules(globalRules, userAgent, "global");
    if (result.matched) return result;
  }
  if (channelRules.length > 0) {
    const result = applyRules(channelRules, userAgent, "channel");
    if (result.matched) return result;
  }
  if (modelRules.length > 0) {
    const result = applyRules(modelRules, userAgent, "model");
    if (result.matched) return result;
  }
  return { matched: false };
}

/**
 * 仅针对「渠道 + 模型」层级的 UA 限制做校验（不含全站规则）。
 * 用于路由选择阶段：返回未命中或放行的路由可用，命中 deny 的路由应被排除。
 */
export function checkScopedUaRestrictions(
  userAgent: string | null,
  channelRulesRaw: string | null | undefined,
  modelRulesRaw: string | null | undefined,
): UaRestrictionMatch {
  const channelRules = parseUaRestrictions(channelRulesRaw);
  const modelRules = parseUaRestrictions(modelRulesRaw);
  if (channelRules.length === 0 && modelRules.length === 0) return { matched: false };
  return checkUserAgentRestrictions({ userAgent, globalRules: [], channelRules, modelRules });
}

export function validateUaRestrictionRules(input: unknown): { valid: true; rules: UaRestrictionRule[] } | { valid: false; error: string } {
  if (input === null || input === undefined) {
    return { valid: true, rules: [] };
  }
  if (typeof input === "string") {
    if (input.trim() === "") return { valid: true, rules: [] };
    try {
      const parsed = JSON.parse(input);
      return validateUaRestrictionRules(parsed);
    } catch {
      return { valid: false, error: "UA 限制规则不是合法的 JSON 数组。" };
    }
  }
  if (!Array.isArray(input)) {
    return { valid: false, error: "UA 限制规则必须为数组。" };
  }
  if (input.length > MAX_RULES) {
    return { valid: false, error: `UA 限制规则最多 ${MAX_RULES} 条。` };
  }
  const rules: UaRestrictionRule[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== "object") {
      return { valid: false, error: `第 ${i + 1} 条 UA 限制规则格式不正确。` };
    }
    const record = item as Record<string, unknown>;
    const pattern = typeof record.pattern === "string" ? record.pattern : "";
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return { valid: false, error: `第 ${i + 1} 条 UA 限制规则的模式过长（最大 ${MAX_PATTERN_LENGTH} 字符）。` };
    }
    const mode = record.mode === "deny" ? "deny" : "allow";
    const errorCode = Number(record.error_code);
    if (!Number.isFinite(errorCode) || errorCode < 100 || errorCode > 599) {
      return { valid: false, error: `第 ${i + 1} 条 UA 限制规则的 error_code 必须为 100-599 之间的数字。` };
    }
    const errorMessage = typeof record.error_message === "string" && record.error_message.length > 0
      ? record.error_message
      : "客户端 User-Agent 不被允许访问该资源。";
    rules.push({ pattern, mode, error_code: Math.trunc(errorCode), error_message: errorMessage });
  }
  return { valid: true, rules };
}
