// 验证 UA 限制规则匹配自动忽略大小写。
// 直接复用编译逻辑（与 lib/gateway/ua-restrictions.ts 保持一致），不引入测试框架。
import { safeRegexTest } from "../lib/shared/claim-expr.ts";

const REGEX_PREFIX = "regex:";
function wildcardToRegex(pattern) {
  let escaped = "";
  for (const ch of pattern) {
    if (ch === "*") escaped += ".*";
    else if (".+?^${}()|[]\\".includes(ch)) escaped += "\\" + ch;
    else escaped += ch;
  }
  return new RegExp(`^${escaped}$`, "i");
}
function compilePattern(pattern) {
  if (!pattern.startsWith(REGEX_PREFIX)) return wildcardToRegex(pattern);
  return new RegExp(pattern.slice(REGEX_PREFIX.length), "i");
}
function ruleMatches(pattern, userAgent) {
  if (pattern.length === 0) return false;
  if (userAgent === null) return pattern === "" || pattern === '""';
  try { return safeRegexTest(compilePattern(pattern), userAgent); } catch { return false; }
}

const cases = [
  ["通配符小写规则匹配大写UA", "mozilla/*", "Mozilla/5.0", true],
  ["通配符大写规则匹配小写UA", "MOZILLA/*", "mozilla/5.0", true],
  ["通配符混合规则匹配混合UA", "MyApp/*", "myapp/1.0", true],
  ["正则规则忽略大小写", "regex:.*bot.*", "MyBot/1.0", true],
  ["正则前缀大写忽略大小写", "regex:.*BOT.*", "mybot/1.0", true],
  ["大小写不同不应误匹配其它规则", "curl/*", "CURL/8.0", true],
];

let pass = 0;
for (const [name, pattern, ua, expect] of cases) {
  const got = ruleMatches(pattern, ua);
  const ok = got === expect;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${name}: pattern=${pattern} ua=${ua} => ${got} (expect ${expect})`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
