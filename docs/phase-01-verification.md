# 阶段一验证记录

验证日期：2026-10-28。环境：Windows 11、Node.js 24.9.0、pnpm 12.14.0。开发分支：`feat/agent-invocation`。

## 已实现

- `src/api/app.ts`：健康接口与非持久化 `POST /agent/invoke`，JSON / 字段校验、32 KiB 流式 body 限制、稳定错误与 HTTP 映射。
- `src/agent/invoke.ts`：可注入模型、工具、时钟和事件观察者的执行器，步数上限、总超时、AbortSignal、步骤摘要与元数据事件。
- `src/models`：厂商中立的解析边界与确定性 mock；未配置不请求 Gateway，生产环境拒绝 mock。
- `src/tools/reference.ts`：唯一的运行时工具 `lookup_reference`，固定映射、zod 输入校验、无外部副作用。
- `src/test/setup.ts`：普通测试拦截意外 fetch，不读取开发 `.env`；失败工具和 `ai/test` 模型仅在测试中使用。

## SDK 选择

使用已安装的 `ai@7.0.130`，采用 `streamText` + `isStepCount` + `stream` 完整事件流。`ToolLoopAgent.stream()` 也能提供完整事件，但未直接开放 `onError` 配置；这里直接使用 `streamText`，覆盖 SDK 默认错误日志，避免原始模型错误进入 stdout / stderr。额外 stop condition 在工具错误或非法请求后阻止下一次模型调用，AbortController 用于中断当前调用。

非法参数与未知工具从 `tool-call.invalid` 及 SDK 错误类型分类；不依赖后续 `tool-error` 中可能已被字符串化的错误。SDK 负责工具运行时校验，非法参数不会进入 execute。每步文本单独收集，最终 output 为最后一步文本；步骤摘要保留此前已完成工具效果。

## 执行结果

| 命令 / 检查 | 结果 |
| --- | --- |
| 开发前 `pnpm check` | 通过，原有 2 个测试文件 / 4 个测试 |
| 新增契约测试的初次执行 | 按预期失败：模型解析与执行器模块尚不存在 |
| 工具分类测试 | 初次发现未知工具被误分类；改为在非法 tool-call 中分类后通过 |
| `pnpm install --frozen-lockfile` | 当前工作区通过；Magpie 接入新增精确依赖 `@ai-sdk/openai@4.0.88`，lockfile 已同步 |
| `pnpm run doctor` | 通过；依赖可解析，不连接数据库或模型 |
| `pnpm check` | 通过：Biome、严格类型检查、5 个文件 / 45 个离线测试和构建 |
| `pnpm smoke:phase-01` | 通过：实际启动构建服务，健康接口、mock 工具回填、元数据日志及生产 mock 拒绝均成功 |
| 构建产物检查 | `dist` 无测试文件或测试 setup |
| 独立干净检出 | 2026-10-28 对提交 `76196e7` 创建独立 worktree；无 `.env` 与个人 MCP 配置，frozen install、完整检查（45 个测试）和本地服务 smoke 全部通过 |

离线用例覆盖：无工具文本、单次工具调用、未知参考 key、非法参数不执行、未知工具拒绝、工具失败与此前步骤保留、模型错误脱敏且不重试、步数上限、模型等待与工具执行期间的超时 / 取消、预先取消、SDK 用量原样返回、缺失模型配置、HTTP 非法输入、无 Content-Length 的超限流、loopback 与配置上限、生产 mock 保护。

测试注入固定关联 ID、固定时钟与确定性模型，取消测试使用虚拟计时器；连续运行结果一致。mock 无真实 token 用量，响应 usage 为 null；使用测试模型提供用量时直接返回 SDK 聚合结果，不估算。

## Magpie 真实模型验证

2026-10-28 在本地 PowerShell 执行 `$env:RUN_MODEL_SMOKE="1"; pnpm smoke:model`，退出码 0。

- 模型：`workbuddy-ai/deepseek-v4.1-flash`，通过本机 Magpie 的 Chat Completions 接口调用。
- 输入：要求恰好调用一次 `lookup_reference`，使用 `{ "key": "lore" }`，随后概括工具返回值。
- 断言通过：`finishReason=completed`、工具调用恰好一次、工具名称及参数正确、工具执行成功、最终文本非空。
- SDK 返回用量：输入 764 tokens（其中缓存读取 256），输出 80 tokens，总计 844 tokens。未推算费用。
- 测试走真实模型与实际执行器，未启动 HTTP 服务；HTTP 路由由此前本地 mock 服务 smoke 验证。

## 未运行与边界

- 公开内容检查：`.env` 和个人 `.mcp.json` 均未跟踪；提交通用 `.env.example` 和只读 `.mcp.example.json`。文档不包含个人数据库连接串、项目标识或本机路径，仅保留项目功能与验证信息。
- **广泛自然语言质量评估、其他模型与 Responses 真实调用：未运行。** 当前真实证据仅覆盖上述 DeepSeek 工具 smoke，不代表所有模型或任务质量均通过。
- **真实数据库、队列、MCP、审批、记忆：未运行且未实现。** 原有开发数据库检查脚本不属于阶段一执行路径，`docs/acceptance.md` 的后续功能不勾选。
- 仅本机 loopback 演示，未部署到服务器；smoke 脚本自动关闭其创建的进程。
- 记录仅在内存；没有 checkpoint、恢复、租约或 exactly-once。取消能力依赖模型与工具响应 AbortSignal，无法强制终止无视信号的第三方代码。同一步多个工具调用可能并行，错误终止不保证其他已启动调用尚未执行；当前工具无外部副作用。
