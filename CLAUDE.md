# 开发约定

`AGENTS.md` 与 `CLAUDE.md` 为独立文件，内容保持同步。开发时应合理配置子 agent 以提升效率。

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
- 回复用户前应对本次新产生的尚未提交的代码做审计（必须使用独立 subagent 执行），确认无安全/逻辑问题后再回复。审计工作流程本身无需再次审计，仅限有新修改的代码时需要调用

## 代码审计

审计由专用 subagent 执行，主 agent 只负责触发和按 subagent 结果行动。

### 触发条件

- 本次产生了新修改（工作区/暂存区有尚未提交的变更），且准备向用户交付时触发
- 审计工作流程本身无需再次审计

### 执行流程

主 agent 触发审计 subagent（使用独立 agent，不继承对话上下文，审计所需信息均在 prompt 中写明），subagent 在后台独立完成：

1. 通过 `git diff` / `git status` 获取尚未提交的变更范围
2. 结合主 agent 转发的本次审计目标，判断改动是否达到目标
3. 逐项检查：安全漏洞、鉴权缺陷、SQL 注入、协议转换丢字段、边界条件、错误处理
4. 发现问题时，**只记录不修复**，按严重程度分级：
   - **高危**：安全漏洞、数据丢失风险等
   - **中危**：逻辑缺陷、非预期行为等
   - **低危/建议项**：代码风格、可读性等
5. 审计完成后，subagent 向主 agent 返回审计报告：
   - 检查了哪些项、是否达到目标
   - 问题列表（位置、描述、严重程度、修复建议）
   - 结论：通过（无高危/中危）或未通过

### 主 agent 职责

- 触发时必须在 prompt 中附上**本次目标**和**大致的改动范围**
- 收到审计报告后：
  - **通过**：低危/建议项也需要尽可能修复；确实无法在本轮处理或属主观偏好的，需在 commit body 说明不采纳理由；修复后正常回复用户
  - **未通过**：由主 agent 指挥修复，修复完成后重新触发审计，形成「审计 → 修复 → 再审计」循环
- 不自行执行审计流程（那是 subagent 的事）

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
- 精简版不再主动维护：新增功能无需为精简版补门控或保证行为一致，`features.ts` 的精简版开关保留但不强制维护；`API.md` 的精简版差异说明可能滞后，无需随版本差异同步

## 代码风格

- 不加多余注释，代码自解释
- 不加 emoji
- 错误信息使用中文
- TypeScript strict 模式，CI 构建用 Next.js 的类型检查（比本地 tsc 更严格）
- 新增 DB 列用 `ensureColumn`，不改 CREATE TABLE
- MySQL 建表时 `TEXT`/`BLOB` 列不可用非空字面量默认值（如 `DEFAULT ''`），需写 `DEFAULT NULL`；SQLite 版无此限制，两套 schema 按各自语法书写
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
