# 架构与选型

状态：阶段一最小调用闭环已实现并通过当前工作区验证；持久化任务、审批、记忆与 MCP 等业务模块仍为规划。阶段一验证结果见 `phase-01-verification.md`。

## 第一版形态

单用户开发环境、单 Agent、单模型连接、一个外部 MCP 测试服务、最小聊天与审批入口。先用一个 Node.js ESM 包，按模块组织；出现明确构建或发布需求后再拆 workspace。

计划数据流：HTTP 提交请求 → 保存 Run 并提交任务 → Worker 领取与续租 → 组织上下文 → AI SDK 模型调用 → 后端工具授权 / 审批 → 保存工具结果与事件 → 查询或流式展示。

阶段一包含 `src/api`、`src/config`、`src/agent`、`src/models` 与固定工具 `src/tools`。后续逐项引入 `runs`、`approvals`、`memory`、`db` 和 `worker` 模块，不预先堆积空接口。首个持久化切片时再选择数据库迁移工具，评估 SQL-first 与 Prisma，重点看条件更新、事务和队列状态协作是否清晰；当前未引入 ORM 或创建 schema。

## 技术职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| TypeScript / Node.js 24 | 严格类型与常驻服务 | 依靠类型替代运行时校验 |
| Hono | HTTP 请求、查询状态，后续事件流 | 将长任务绑定请求生命周期 |
| Vercel AI SDK 7 | 模型协议、工具调用类型及调用辅助能力 | 自动提供数据库租约、checkpoint、原参数审批与外部 exactly-once |
| PostgreSQL 14+ | Run、租约、审批、记忆修订、事件与工具效果的持久化 | 保证外部 API 与本地事务原子提交 |
| Graphile Worker | PostgreSQL 队列、任务唤醒与基础重试 | 替代应用层执行所有权与业务恢复协议 |
| AI SDK MCP 包 | 连接外部 MCP 服务 | 把 stdio 工具变成容器沙箱 |

开发数据库使用 **Supabase Postgres**。应用和 Worker 走 Session pooler（5432）或直连，以保留会话级的 advisory lock、LISTEN/NOTIFY 与 prepared statement；**不使用 Transaction pooler（6543）**。连接串带 `?sslmode=require`，凭据只放在本地 `.env`。Supabase 只承担托管数据库，不使用其 Auth、Storage、Edge Functions 或浏览器端 SDK，避免把架构绑到某个后端平台；本地开发不依赖 Docker。

仓库提供不含个人项目标识的 `.mcp.example.json`；复制为 Git 忽略的本地 `.mcp.json` 后可使用只读 Supabase MCP，供开发时查询 schema 与文档，**不是 Lore 的运行时依赖**，也不替代项目迁移。数据库 schema 仍由代码仓库中的迁移管理。

模型 provider 选择本机 Magpie，通过 `@ai-sdk/openai@4.0.88` 接入 Chat Completions / Responses 兼容协议，与 `ai@7.0.130` 使用同版本 provider 类型。服务商翻译与配置集中在模型适配层，模型 ID 由配置提供，核心业务不读取某厂商的环境变量。使用 Vercel AI SDK 不代表必须使用 Vercel AI Gateway 或 Vercel 托管；带持久 Worker 的服务先按普通 Node.js 进程设计。

## 核心模块

- 持久化任务：使用 PostgreSQL 保存执行状态，Graphile Worker 唤醒任务；通过租约、fence 与补偿扫描处理执行接管和故障回收。
- 人工审批：持久化原工具请求、checkpoint 与效果记录；批准后按原参数恢复，外部动作结果未知时进入 `uncertain` 等待核对。
- 记忆与上下文：记忆文档使用版本校验防止丢失更新，冲突后重新读取；历史摘要记录覆盖范围，按预算保留完整工具调用与结果组。
- 工具目录与授权：小目录直接提供工具定义，大目录通过 search / load / execute 按需加载；发现与实际调用均检查分配权限和 allowlist。

## 实现次序

1. 工程准备：依赖、配置、健康接口、离线检查与验收文档。
2. 最小调用闭环：先用显式 mock 和无副作用工具连接 AI SDK，结构化记录调用过程；真实服务商确定后单独验证，不先做 UI。
3. 持久执行：数据库 schema / 迁移、Run 状态、队列、租约、fence、回收与故障注入。
4. 审批恢复：原请求、暂停 checkpoint、幂等审批决策、effect 状态与 uncertain。
5. 记忆与预算：修订、摘要范围、完整工具组、必要内容超限错误。
6. MCP 与目录：一个测试服务、目标与 schema 校验、分配权限、执行前重查，再扩展大目录；最小界面串联演示。

默认测试使用受控模型 / 工具 fixture；真实 PostgreSQL 验证并发和事务，真实模型验证自然语言任务质量。两类证据分开记录。吞吐、延迟、成本等结果必须基于实际测量。
