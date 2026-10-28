# Lore

使用 TypeScript + Vercel AI SDK 构建的工具型 Agent，计划支持持久化任务、人工审批、版本化记忆和 MCP 工具调用。服务按普通 Node.js 进程设计，不要求部署到 Vercel。

当前阶段：**阶段一，最小 Agent 调用闭环**。提供本地健康接口、非持久化调用接口、独立执行器、显式 mock 模型、固定参考工具与结构化事件。执行通过 Vercel AI SDK，支持步数上限、超时和取消。模型可使用本机 Magpie 网关，支持 Chat Completions 与 Responses 协议；已通过 DeepSeek 的真实工具调用 smoke。持久化任务、审批、记忆、MCP 和 UI 尚未实现。

## 阶段一演示

PowerShell 启动离线 mock 服务（构建后可将 `pnpm dev` 换成 `pnpm start`）：

```powershell
$env:MODEL_PROVIDER="mock"
pnpm dev
```

另一个终端调用：

```powershell
curl.exe -s http://127.0.0.1:3001/agent/invoke -H "Content-Type: application/json" --data-raw '{"message":"lore"}'
```

`message` 为参考 key：`lore`、`stage-01` 可命中固定映射，其他 key 返回 `found: false`；`text:hello` 演示无工具文本路径。mock 是确定性的协议演示，不理解任意自然语言。所有响应明确标识 `model: "mock:reference-v1"`，不产生真实 token 用量，`usage: null`。

请求必须为 JSON，且仅包含非空 `message`（最多 8,000 字符），body 最多 32 KiB。响应包含 `invocationId`、`model`、`output`、`finishReason`、工具调用 `steps`、元数据 `events` 与 `usage`；失败额外返回稳定的 `error.code` / `error.message`，保留此前步骤。正常结束为 `finishReason: "completed"`，失败时为对应错误码。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 格式、字段、长度或 body 大小不合法 |
| `MODEL_NOT_CONFIGURED` | 503 | 未配置支持的模型 provider |
| `MODEL_ERROR` | 502 | 模型调用失败或返回不支持的结果 |
| `TOOL_INPUT_INVALID` / `TOOL_NOT_ALLOWED` | 422 | 非法参数或未注册工具 |
| `TOOL_ERROR` | 502 | 工具执行失败，终止循环 |
| `STEP_LIMIT` | 422 | 已达到模型步数上限 |
| `TIMEOUT` | 504 | 调用超时 |
| `ABORTED` | 408 | 调用已取消 |

日志只输出关联 ID、事件、步骤、工具名、状态与耗时，不输出消息、参数、工具结果正文或原始错误。响应中的已校验参数与工具结果供本地调用者查看。调用不持久化，不提供恢复能力；取消依赖模型和工具配合 AbortSignal，不能强行终止无视信号的第三方代码。验证记录见 [phase-01-verification.md](docs/phase-01-verification.md)。

## 开始开发

需要 Node.js 24.x（`.nvmrc` 记录当前基线 24.9.0）、pnpm 12.14.0。可用 `corepack pnpm` 替代 `pnpm`；不需要全局修改 npm 镜像或安装新 Node。

在本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm check
pnpm dev
```

健康接口：`http://127.0.0.1:3001/health`。它只证明 HTTP 进程可响应，不证明数据库或模型可用。`pnpm build` 后使用 `pnpm start` 启动编译产物。

其他检查：

```sh
pnpm test src/config/env.test.ts
pnpm test src/config/env.test.ts -t "rejects invalid ports"
pnpm test:watch
pnpm format
pnpm smoke:phase-01
```

`pnpm smoke:phase-01` 构建并实际启动本地服务（端口 13001），验证健康接口、mock 工具闭环、元数据日志和生产 mock 保护，然后关闭进程。该检查仅访问 loopback，不调用真实模型。

`pnpm check` 依次执行 Biome、TypeScript、离线测试和构建，不调用付费模型、不要求数据库。后续真实数据库测试和真实模型评估需提供单独入口，不得伪装为已运行。已提供 GitHub Actions 检查配置，在 push 和 pull request 时运行离线检查；远程结果以对应 workflow 为准。

## 配置环境

本地配置不随仓库分发；新检出项目若没有 `.env`，将 `.env.example` 复制为 `.env`（PowerShell：`if (-not (Test-Path .env)) { Copy-Item .env.example .env }`）。环境变量允许暂时为空，健康接口仍可启动。

- `HOST` / `PORT`：默认仅监听 `127.0.0.1:3001`。
- `DATABASE_URL`：指向 **Supabase Postgres** 的专用开发项目。使用 Session pooler（5432）或直连，**不要用 Transaction pooler（6543）**，因为 Graphile Worker 依赖会话级的 advisory lock、LISTEN/NOTIFY 与 prepared statement。连接串追加 `?sslmode=require`，密码中的特殊字符需要 URL 编码。
- `MODEL_PROVIDER`：`mock` 为离线演示，`magpie` 为真实模型网关；留空或其他值时调用接口返回 503。`NODE_ENV=production` 禁止 mock。
- Magpie 必填 `MODEL_ID`；`MODEL_BASE_URL` 默认 `http://127.0.0.1:3425/v1`，`MODEL_API_KEY` 默认本机网关占位值 `magpie`（实例要求认证时设置真实 key）。不会回退到 OpenAI 官方地址或 Vercel Gateway。
- `MODEL_API`：`chat`（默认）调用 `/chat/completions`，`responses` 调用 `/responses`；按 Magpie `/v1/models` 返回的 `native_endpoints` 选择。当前本地 `workbuddy-ai/deepseek-v4.1-flash` 使用 `chat`；Codex 模型使用 `responses`。模型 ID 由配置提供。
- 启动服务、解析模型与 `doctor` 均不生成内容；配置 Magpie 后发送 `/agent/invoke` 会触发真实模型请求。
- `AGENT_MAX_STEPS`：默认 4，允许 1–8，由服务端控制；`AGENT_TIMEOUT_MS`：默认 30000，允许 1–120000。客户端不能放大这些限制。
- `HOST` 必须为 `127.0.0.1`，本阶段不支持公开监听或 CORS。

数据库就绪后执行：

```sh
pnpm db:check
```

该命令仅连接并读取版本，不迁移、不建表。`dev`、`start` 和 `db:check` 已通过 `scripts/with-ca.mjs` 在 Node 启动前自动加载仓库内的 Supabase 官方 CA，无需手动设置环境变量，证书校验保持开启。证书来源、指纹和部署要求见 [certs/README.md](certs/README.md)。当前没有迁移器、业务 schema 或队列 Worker；因此不能运行并不存在的 `db:migrate` / `dev:worker`。

Supabase 项目可在 Dashboard → Connect 复制连接串，或在本机使用 Supabase CLI 拉取环境变量。**不要把连接串、密码或 `service_role` key 提交到仓库或发到聊天中**；`.env` 已在 `.gitignore` 内。服务端只使用数据库连接串，不使用浏览器端 `anon` key。

### Supabase MCP（可选）

如需 Supabase MCP，将 `.mcp.example.json` 复制为本地 `.mcp.json`，再按需配置项目范围；`.mcp.json` 已被 Git 忽略，不提交个人项目标识。示例启用只读模式，仅用于在 Claude Code 中查询 schema、文档和调试信息，**不是 Lore 运行时的依赖**，也不替代应用自己的数据库迁移。首次使用需在普通终端运行 `/mcp` 完成 OAuth 授权；工具权限应限制为只读，写操作（迁移、SQL 执行）由项目自己的迁移流程完成。`npx skills add supabase/agent-skills` 为可选项，安装前先确认来源与内容。

### Magpie 模型调用

在本地 `.env` 中配置（网关需先启动）：

```dotenv
MODEL_PROVIDER=magpie
MODEL_ID=workbuddy-ai/deepseek-v4.1-flash
MODEL_BASE_URL=http://127.0.0.1:3425/v1
MODEL_API_KEY=magpie
MODEL_API=chat
```

运行 `pnpm dev`，再向调用接口发送自然语言消息，例如“调用 lookup_reference 查询 lore，然后概括结果”。如果此前用 PowerShell 设置过 mock，先执行 `Remove-Item Env:MODEL_PROVIDER -ErrorAction SilentlyContinue`，以免进程环境覆盖 `.env`。

真实模型 smoke 单独显式开启，可能产生模型用量；普通测试与 CI 不执行：

```powershell
$env:RUN_MODEL_SMOKE="1"
pnpm smoke:model
Remove-Item Env:RUN_MODEL_SMOKE
```

该命令验证一次真实工具调用和最终文本，只输出模型标识、结束原因与 SDK 用量；默认超时沿用 `AGENT_TIMEOUT_MS`。2026-10-28 已通过 `workbuddy-ai/deepseek-v4.1-flash` 的真实生成 smoke：工具调用一次、结果回填、最终文本及正常结束均通过；其他模型与 Responses 真实调用尚未验证。

## 开发边界与路线

- 阶段一仅提供本地、单次、非持久化调用；后续实现以对应阶段的验收标准为准。
- 首期做单用户开发环境、单 Agent、一个模型连接、一个外部 MCP 测试服务和最小 Web 入口；公开部署前必须补齐真实认证与隔离。
- API 接收意图、查询状态；后续 Worker 驱动持久任务。模型适配器调用 Vercel AI SDK，数据库负责应用状态，工具执行经过后端授权。
- 功能验收标准见 [acceptance.md](docs/acceptance.md)；技术职责和实现路线见 [architecture.md](docs/architecture.md)。所有业务验收当前均待完成。

## 还需要准备

1. Supabase 项目的 `DATABASE_URL`（Session pooler 或直连，带 `?sslmode=require`），以及用于本地 `.env` 的数据库密码。不需要 Docker。
2. 启动本机 Magpie 并保持其上游登录有效；DeepSeek 的 Chat Completions 接入已通过真实工具闭环验证。密钥只在本地配置。
3. Docker 可推迟到计算环境隔离阶段；第一版不执行宿主机 shell，也不接入具有真实写入副作用的外部工具。

参考资料：[Vercel AI SDK](https://ai-sdk.dev/docs)、[Graphile Worker](https://worker.graphile.org/)。具体 API 以已安装版本的类型与文档为准。
