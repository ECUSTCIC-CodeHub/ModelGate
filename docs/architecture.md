# 项目分层架构

## 路由层（Route Layer）
- 目录：`app/api/**`
- 职责：
  - 处理 HTTP 协议细节（参数、状态码、响应格式）
  - 鉴权与权限校验
  - 调用服务层，不直接承载复杂业务流程

## 逻辑层（Service Layer）
- 目录：`lib/services/**`
- 职责：
  - 业务规则与流程编排
  - 例如：软删除策略、重试策略、网关转发策略

## 数据层（Data Layer）
- 目录：`lib/data/**`
- 职责：
  - 面向表的持久化读写
  - 对外提供明确的 repository 接口
  - 不包含路由协议和页面逻辑

## 工具层（Utility Layer）
- 目录：`lib/*.ts`（`utils/tokenizer/http/validation` 等）
- 职责：
  - 通用能力：HTTP 结构化响应、token 估算、校验工具、JWT 工具

## 当前重点落地
- 日志写入已下沉到数据层：`lib/data/repositories/log-repository.ts`
- 软删除流程已下沉到逻辑层：`lib/services/soft-delete-service.ts`
- 路由层只负责鉴权/参数/响应与服务调用。
