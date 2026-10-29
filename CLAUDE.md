# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 当前范围

Lore 是使用 TypeScript + Vercel AI SDK 构建的工具型 Agent 项目。当前实现阶段一的最小调用闭环：`POST /agent/invoke`、独立执行器、显式 mock 模型、固定无副作用工具、结构化事件与离线测试。

支持 `MODEL_PROVIDER=mock` 与本机 Magpie（`magpie`）；Magpie 通过 `@ai-sdk/openai` 使用兼容协议，`MODEL_API=chat|responses`、模型 ID 和地址由配置决定。生产环境拒绝 mock；未配置时 `/health` 仍可用，调用接口返回 `MODEL_NOT_CONFIGURED`。记录只在内存中存在，没有数据库、队列、审批、记忆、MCP 或 UI 实现。`@ai-sdk/mcp`、`pg`、Graphile Worker 仅完成依赖准备。后续实现按 `docs/acceptance.md` 验证，未完成项不能当作已有能力。

## 命令

从仓库根目录运行，Node.js 24.x、pnpm 12.14.0：

- `pnpm install --frozen-lockfile`：按 lockfile 安装。
- `pnpm run doctor`：校验 Node、环境解析与依赖解析，不连接外部服务。
- `pnpm dev`：启动仅监听 loopback 的 Hono 开发服务，默认 3001。
- `pnpm build` / `pnpm start`：生成并运行 `dist/api/index.js`。
- `pnpm lint` / `pnpm format`：Biome 检查 / 应用格式和安全修复。
- `pnpm typecheck`：TypeScript 严格检查。
- `pnpm test` / `pnpm test:watch`：Vitest 离线测试。
- `pnpm smoke:model`：显式设置 `RUN_MODEL_SMOKE=1` 后验证真实 Magpie 工具闭环，可能产生模型用量；不属于普通测试或 CI。
- `pnpm smoke:phase-01`：构建并启动本地 mock 服务验证 HTTP 闭环及生产 mock 保护；仅访问 loopback，自动关闭进程。
- `pnpm test src/config/env.test.ts`：单文件；追加 `-t "rejects invalid ports"` 跑单用例。
- `pnpm check`：lint → typecheck → test → build。
- `pnpm db:check`：显式使用 `.env` 中 DATABASE_URL，仅做只读连接与版本检查。数据库为 **Supabase Postgres**：使用 Session pooler（5432）或直连，不要用 Transaction pooler（6543），Graphile Worker 的 advisory lock、LISTEN/NOTIFY 与 prepared statement 都依赖会话。

阶段一演示：PowerShell 中执行 `$env:MODEL_PROVIDER="mock"; pnpm dev`，再向 `/agent/invoke` 发送 JSON `{ "message": "lore" }`；`text:hello` 演示无工具路径。`AGENT_MAX_STEPS` 默认 4、范围 1–8，`AGENT_TIMEOUT_MS` 默认 30000、范围 1–120000。仅固定监听 `127.0.0.1`，请求主机名仅允许 loopback；Magpie 的 HTTP 地址只允许 loopback，远程地址必须 HTTPS。

目前没有 Worker 启动或业务迁移命令，新增实现后同步命令文档。`dev`、`start`、`db:check` 通过 `scripts/with-ca.mjs` 在子 Node 启动前加载 `certs/supabase-root-2021.crt`，启动器转发 SIGINT / SIGTERM；数据库检查对远程地址强制 TLS 并校验证书，不可用关闭 TLS 校验代替；新增数据库运行入口也应复用此启动器。显式的外部 `NODE_EXTRA_CA_CERTS` 优先。普通测试不读取开发 `.env`、不依赖真实数据库或模型。真实数据库与真实模型测试应分离并显式开启。

## 结构与依赖方向

先用一个 ESM 包按模块分层，后续 API 和 Worker 独立进程；不预建完整多包仓库。相对 TypeScript imports 使用编译后的 `.js` 后缀。SDK 已有类型直接复用，不为它们再定义同形数据结构。

- HTTP 层只接收请求、验证输入、展示状态；执行流程与权限裁决放后端应用层。
- 后续 Worker 通过应用执行器驱动任务；Graphile Worker 是唤醒与重试设施，应用的 Run、租约、fence、工具效果记录才是业务状态来源。
- 模型调用集中到 Vercel AI SDK 适配层；当前接入本机 Magpie，不默认走 Vercel AI Gateway，不写入固定模型 ID，不自动触发付费调用。
- 数据库访问集中在存储模块；核心状态转换不直接依赖 HTTP 或模型提供商。
- 工具入口先验证实际目标、参数与最新权限，再执行外部调用。MCP 在这里是客户端连接外部服务。
- 开发数据库使用 Supabase Postgres，经 Session pooler（5432）或直连访问；Worker 不使用 Transaction pooler（6543）。本地 `.mcp.json`（由 `.mcp.example.json` 复制，Git 忽略）的 Supabase MCP 只供开发时查询，不是运行时依赖，也不替代项目自己的迁移。

模块规划、选型及演进路线见 `docs/architecture.md`。没有需求驱动时不提前添加 provider registry、空接口或业务占位实现。

## 功能边界

- 任务：条件领取、续租、过期回收、fence 约束旧执行者写入。fence 不能自动阻止外部副作用，不宣传 exactly-once 或任意崩溃点无损续跑。
- 审批：持久化原工具请求、参数与 checkpoint；等待释放执行资源，恢复使用原批准参数。已完成效果复用，结果未知进入 uncertain，不能盲目重放。SDK 审批 API 不能替代应用持久化协议。
- 记忆：版本冲突保护、历史摘要覆盖检查、预算预留、工具调用与结果整组裁剪；必要内容过大显式报错。未实现向量索引时不能写成向量 RAG，估算不能写成精确 token 计数。
- 工具：少量直出、大目录按需加载；发现和执行都检查分配与 allowlist。发现时授权不能代替调用时授权，stdio 不等于沙箱隔离。

通过故障注入、状态转换与权限变化验证系统行为，验收结论以实际测试结果为准。
