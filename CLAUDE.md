# 开发约定

## 提交规范

- 不主动 push，等用户指示
- commit message 带 `[ci skip]` 仅限文档变更
- 功能变更同时更新 API.md（中文）

## API 文档

- 新增/修改 API 端点后，必须同步更新 `API.md`
- 文档使用中文
- 包含：请求方法、路径、认证方式、请求体字段、响应示例

## 代码风格

- 不加多余注释，代码自解释
- 不加 emoji
- 错误信息使用中文
- TypeScript strict 模式，CI 构建用 Next.js 的类型检查（比本地 tsc 更严格）
- 新增 DB 列用 `ensureColumn`，不改 CREATE TABLE

## 分支

- `main`: 完整功能（含 OIDC、周期配额、公告等）
- `lite`: 精简版（无 OIDC、无周期配额、无公告）
- 两个分支共享同一数据库格式，切换不会损坏数据

## 安全

- JWT 密钥通过环境变量配置（`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`），未配置时用 `globalThis` 缓存的随机值
- Cookie `secure: false`（反代层处理 HTTPS）
- 登录接口有 IP 限流（5 次/分钟）
- 注册接口不泄露用户名是否存在
