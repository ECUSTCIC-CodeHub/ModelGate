# 开发约定

`CLAUDE.md` 是本仓库开发规范的唯一来源；`AGENTS.md` 通过软链指向本文件，不单独维护。

## 提交规范

- 不主动 push，等用户指示
- commit message 带 `[ci skip]` 仅限文档变更
- 不同主题的变更必须拆成多个 commit，不把无关改动混在一起
- 提交格式固定为：

```text
<type>(<scope>): <subject>

- <item>
```

- `subject` 和 `<item>` 使用中文
- body 使用 `- ` 列出本次提交的具体事项
- 功能变更同时更新 `API.md`（中文）

## API 文档

- 新增/修改 API 端点后，必须同步更新 `API.md`
- 文档使用中文
- 包含：请求方法、路径、认证方式、请求体字段、响应示例
- 修改 API 行为、认证方式、CORS 范围、版本差异时，也要同步更新 `API.md`

## 版本与制品

- 不再维护 `lite` 分支，一份代码通过构建参数生成不同制品
- `MODELGATE_EDITION=full` / `NEXT_PUBLIC_MODELGATE_EDITION=full` 为完整版
- `MODELGATE_EDITION=lite` / `NEXT_PUBLIC_MODELGATE_EDITION=lite` 为精简版
- 本地开发分别使用 `npm run dev:full` 和 `npm run dev:lite`
- main push 只负责自动生成 tag；tag push 构建完整版镜像并推送 `latest` 和 tag 名，同时构建精简版镜像并推送 `lite`
- 完整版和精简版共享同一数据库结构，切换制品不能损坏数据
- 精简版关闭功能时，必须同时关闭页面渲染和后端功能；不能只隐藏页面或只关闭 API

## 代码风格

- 不加多余注释，代码自解释
- 不加 emoji
- 错误信息使用中文
- TypeScript strict 模式，CI 构建用 Next.js 的类型检查（比本地 tsc 更严格）
- 新增 DB 列用 `ensureColumn`，不改 CREATE TABLE
- `lib` 下按职责分类，避免无边界堆放代码
- 可拆成组件或协议模块的大文件要拆薄；抽象必须服务于复用或边界清晰，不做空泛抽象
- 不保留未使用的 SVG、组件、API route 别名或兼容入口

## 协议与网关

- 协议转换按“输入协议 => 中间协议 => 输出协议”组织
- 中间协议需要承载工具调用、推理内容、结构化内容等现有字段，避免转换丢字段
- 每个协议只负责自己的输入转中间协议、或中间协议转自己的输出格式
- 流式转换也按协议归属拆分，不把 Anthropic、Responses、Chat Completions、Ollama 都塞进同一个全局适配器
- `openai-adapter.ts` 不作为全局网关；各协议请求和响应适配器维护自己的边界
- 上游多渠道重试行为和设置页、`API.md` 描述必须一致

## Ollama 兼容

- 不在根路径提供 Ollama 兼容别名，`/api/version`、`/api/show`、`/api/tags` 等根路径不支持
- Ollama 兼容接口只放在 `/api/ollama/*`
- Ollama 鉴权支持 header、query 和 path 三种传参方式
- CORS 开启后需要覆盖 `/api/v1/*` 和 `/api/ollama/*`

## 安全

- JWT 密钥通过环境变量配置（`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`），未配置时用 `globalThis` 缓存的随机值
- Cookie `secure: false`（反代层处理 HTTPS）
- 登录接口有 IP 限流（5 次/分钟）
- 注册接口不泄露用户名是否存在
