import { htmlEscape } from "@/lib/core/html";
import { getGatewaySettings } from "@/lib/core/settings";
import { cssVariablesToText, generateThemeCssVariables, isValidHexColor } from "@/lib/shared/color";

/**
 * 少数没有 React 的出口（API route 直接返回 HTML 的错误页）也要和登录页同一套观感：
 * 主题色渐变底 + 半透明玻璃卡片 + 等宽字标。这里把登录页那套样式浓缩成一份
 * 内联 CSS，避免这些页面再各自长出一套灰底白卡的风格。
 *
 * 主题色取自站点设置，与 ThemeColorSync 用同一个生成函数；这些页面没有 JS，
 * 明暗跟随 prefers-color-scheme，因此主题变量按媒体查询分开输出。
 *
 * 只有 `--glow-a` 真的被 PAGE_CSS 用到——它就是登录页背景里那层主题色光晕。
 * 其余变量（`--color-accent` 等）在这些页面没有对应元素，不输出。
 *
 * 仅供服务端（API route）使用：它读数据库设置，不要从客户端组件引用。
 */
async function themeCss(): Promise<string> {
  let themeColor: string | null = null;
  try {
    const color = (await getGatewaySettings()).theme_color;
    themeColor = isValidHexColor(color) ? color : null;
  } catch {
    // 设置读不到就用默认配色，页面本身不该因此报错
  }
  if (!themeColor) return "";
  const vars = generateThemeCssVariables(themeColor);
  const glowOnly = (record: Record<string, string>) => cssVariablesToText({ "--glow-a": record["--glow-a"] });
  return (
    `:root{${glowOnly(vars.light)}}` +
    `@media (prefers-color-scheme:dark){:root{${glowOnly(vars.dark)}}}`
  );
}

const PAGE_CSS = `
:root{
  --color-bg:#eef2ff;--color-surface:rgba(255,255,255,.68);--color-foreground:#111827;
  --color-foreground-muted:#536179;--color-border:rgba(67,56,202,.14);
  --color-destructive:#dc2626;
  --glow-a:linear-gradient(135deg,rgba(99,102,241,.18),transparent 42%,rgba(129,140,248,.12));
  --glow-b:repeating-linear-gradient(90deg,transparent 0 39px,rgba(67,56,202,.035) 39px 40px);
  --glow-c:linear-gradient(180deg,rgba(255,255,255,.42),rgba(238,242,255,.88));
  --shadow-card:0 8px 24px rgba(30,41,59,.1),inset 0 1px 0 rgba(255,255,255,.55);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --color-bg:#0d1224;--color-surface:rgba(20,26,48,.55);--color-foreground:#f8fafc;
    --color-foreground-muted:#b8c2d6;--color-border:rgba(255,255,255,.12);--color-destructive:#f87171;
    --glow-a:linear-gradient(135deg,rgba(99,102,241,.24),transparent 42%,rgba(79,70,229,.1));
    --glow-b:repeating-linear-gradient(90deg,transparent 0 39px,rgba(255,255,255,.035) 39px 40px);
    --glow-c:linear-gradient(180deg,rgba(13,18,36,.36),rgba(13,18,36,.9));
    --shadow-card:0 10px 28px rgba(0,0,0,.38);
    color-scheme:dark;
  }
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;
  background-color:var(--color-bg);color:var(--color-foreground);
  font-family:"HarmonyOSHans-Regular","PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
body::before{
  content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
  background-image:var(--glow-a),var(--glow-b),var(--glow-c);background-repeat:no-repeat;
}
.wrap{width:100%;max-width:26rem}
.brand{text-align:center;margin:0 0 6px;font-family:"SFMono-Regular",Consolas,Menlo,monospace;
  font-size:1.5rem;font-weight:600;letter-spacing:-.01em}
.sub{text-align:center;margin:0 0 24px;font-size:.875rem;color:var(--color-foreground-muted)}
.card{
  background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:.75rem;
  box-shadow:var(--shadow-card);padding:24px;
  backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);
}
.card h1{margin:0 0 8px;font-family:"SFMono-Regular",Consolas,Menlo,monospace;font-size:1rem;font-weight:600}
.msg{margin:0;font-size:.875rem;line-height:1.6;color:var(--color-foreground-muted)}
.msg--error{color:var(--color-destructive)}
.foot{margin:16px 0 0;font-size:.75rem;line-height:1.6;color:var(--color-foreground-muted);opacity:.8}
`;

/**
 * 渲染一张与登录页同风格的独立错误页。所有文案都会转义。
 *
 * `footer` 由调用方给：同一张卡片里正文说「稍后重试」、页脚说「重新发起登录」会
 * 自相矛盾，而不同失败原因（参数错 / 服务繁忙 / 来源不合法）该给的动作并不一样。
 */
export async function authPageHtml({
  title,
  heading,
  message,
  subtitle = "DSH 接入授权",
  footer,
  theme = true,
}: {
  title: string;
  heading: string;
  message: string;
  subtitle?: string;
  footer?: string;
  /** 传 false 跳过读取站点主题色。数据库饱和时不该为了取一个颜色再打一次库。 */
  theme?: boolean;
}): Promise<string> {
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${htmlEscape(title)}</title>` +
    `<style>${PAGE_CSS}${theme ? await themeCss() : ""}</style></head><body>` +
    `<div class="wrap">` +
    `<p class="brand">ModelGate</p>` +
    `<p class="sub">${htmlEscape(subtitle)}</p>` +
    `<div class="card">` +
    `<h1>${htmlEscape(heading)}</h1>` +
    `<p class="msg msg--error">${htmlEscape(message)}</p>` +
    (footer ? `<p class="foot">${htmlEscape(footer)}</p>` : "") +
    `</div></div></body></html>`
  );
}
