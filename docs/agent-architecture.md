# CardArts Agent 子系统：结构、实现与演变

> 本文档面向想读懂、改懂这个内置智能体的开发者。所有类名、函数名、数字都对应当前磁盘代码。

---

## 1. 它是什么

CardArts 的 Agent 是一个**跑在浏览器里的、直接操作工程的 ReAct 风格循环**：用户用自然语言说一句，模型决定调哪几个工具、工具结果回喂给模型、模型继续下一步，直到把活儿干完。

它和「聊天机器人」的关键区别：

- **工具是一等公民**：67 个工具直接读写 IndexedDB 里的项目（牌组、卡牌、版式、文档、素材），不是只输出建议。
- **本地优先**：LLM 配置（含 API Key）只存在浏览器 IndexedDB，不经过后端落盘。
- **权限分级**：只读工具自动并行放行，写工具串行，删除类要用户确认。

---

## 2. 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层  AgentChat.tsx（聊天窗、@ 提及、确认弹窗、流式渲染）    │
├─────────────────────────────────────────────────────────────┤
│  运行时  agentRuntime.ts   ← 状态机：发请求→解析→执行→回喂   │
│                                                             │
│  协议层  agentProtocol.ts  ← 纯函数：工具说明书/JSON Schema/  │
│                             回复解析/截断抢救/名字归一化      │
│  流层    agentStream.ts    ← SSE 解析，tool_calls 分片累积    │
│  上下文  agentContext.ts   ← 消息裁剪，token 预算控制         │
│  LLM 客户端 llm.ts         ← OpenAI 兼容 chat/completions     │
├─────────────────────────────────────────────────────────────┤
│  动作层  agentTools.ts    ← 67 个动作的真实实现（操作 Dexie） │
├─────────────────────────────────────────────────────────────┤
│  MCP 桥接  mcp.ts（前端拉工具）  +  backend/mcp_manager.py   │
│             （后端 stdio 子进程长驻连接池）                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心模块

### 3.1 `agentProtocol.ts` —— 协议层（纯函数，最易测试）

这一层**不碰 IndexedDB、不碰网络**，全是纯函数，所以单测最多（103 个用例）。

**工具清单 `TOOL_SPECS`**：67 个工具，每条记录 `name / level / doc`。单一数据源——说明书、JSON Schema、自检全从这里派生。

工具分三级（仿 Claude Code 权限模型）：

| level | 行为 | 例子 |
|---|---|---|
| `read` | 自动放行，**并行**执行 | `project.overview`、`card.list`、`web.search` |
| `write` | 自动放行，**串行**执行（避免互相踩踏 IndexedDB） | `card.add`、`element.add` |
| `destructive` | 弹确认框，用户可「本次会话都放行」 | `deck.delete`、`card.delete` |

**`TOOL_PARAMS`**：每个工具的 JSON Schema，喂给原生 function calling。手写了 67 份。

**`buildToolDefinitions(extra)`**：把核心工具 + MCP 远端工具拼成 OpenAI 格式 `{type:'function', function:{name, description, parameters}}[]`。

**`buildSystemPrompt(parts)`**：拼系统提示词。顺序刻意安排：角色 → 工程快照 → 知识包/文档 → 待办 → 工具 → 规则。`nativeTools: true` 时工具说明书不再罗列（交给 schema），否则输出完整工具列表。

**回复解析**：
- `parseReply(text)`：从正文里抠 ` ```json {"actions":[...]} ``` ` 围栏块。
- `salvageTruncatedCalls(text)`：**截断抢救**——遇到未闭合的 JSON 块，把已经写完的动作捞出来执行。
- `normalizeToolName(t)`：容错（`"card add"` / `"cardAdd"` / `"card_add"` → `card.add`）。

**`MAX_ACTIONS_PER_ROUND = 8`**：硬批次上限。

### 3.2 `agentStream.ts` —— SSE 传输

`readSSE(body, onDelta, signal, onFinish, onReasoning, onToolCall)`：

- 严格模式：连接没收到 `[DONE]` 或 `finish_reason` 就抛 `StreamError`，**半成品不算成功回复**。
- **tool_calls 分片累积**：OpenAI 流式返回里，`arguments` 是逐 token 来的字符串片段，按 `index` 攒到一起（`acc.arguments += delta.function.arguments`）。
- 第 6 个回调 `onToolCall` 用于 UI 实时显示「正在调 xxx」。

### 3.3 `agentRuntime.ts` —— 状态机

`runAgent({system, history, userText, complete, execute, ...})`：

```
for round in 0..maxRounds:
  ctx = selectContext(...)          # 按 token 预算裁历史
  reply = await llm(messages)       # 流式
  native = decodeNative(reply.toolCalls)   # 原生路径
  text   = parseReply(reply.content)       # 文本兜底路径
  if truncation:
      抢救已写完的动作，丢弃写一半的
  if 0 个动作:
      要么结束，要么要求模型修正格式
  执行动作 → 结果写回 messages
  连续两轮没新动作 → 停手
```

关键设计：
- **双路径并存**：原生 function calling 为主，JSON 围栏正文解析为兜底（模型偶尔不按 schema 来也能跑）。
- **历史协议**：native 路径写回 `assistant.tool_calls` + 每条结果一条 `role:tool` 消息，严格遵循 OpenAI 多轮工具协议。
- **`decodeNative` 丢弃参数不完整的末条**：被截断的最后一个 tool_call 不执行。

### 3.4 `agentContext.ts` —— 上下文裁剪

`selectContext(system, history, current, contextWindow, outputTokens)`：

- 估算每条消息 token（`contextTokens`，按字符粗估）。
- 固定保留 system + 当前轮，老消息从旧往新丢，保证不超窗口。
- `AgentMessage.role` 是 `'system' | 'user' | 'assistant' | 'tool'`。

### 3.5 `llm.ts` —— OpenAI 兼容客户端

- `chatStream(...)` / `chatComplete(...)` 返回 `CompletionResult { content, toolCalls }`（早期只返 string，改造成本最大的是这个——所有 mock 都得跟着改）。
- `directPayload` 下发 `tools` 和 `tool_choice: 'auto'`。
- `WireMessage` 支持 `tool` 角色。

### 3.6 `agentTools.ts` —— 67 个动作的真实实现

- `createAgentActions()` 返回 `AgentActions`：一个 `Record<工具名, (args) => Promise<string>>`。
- `runToolCalls(calls, actions)`：按 level 决定并行/串行、destructive 弹确认。
- `projectOverview()`：生成工程快照（牌组/字段/卡牌/版式/文档的真实 id），塞进系统提示词，模型不用瞎猜 id。
- `estimateTokens`、`describeCall`、`callKey` 等辅助。

### 3.7 MCP 桥接

**前端 `mcp.ts`**：
- `fetchRemoteTools()`：打开聊天前调后端 `/llm/mcp/tools` 拉远端工具，失败静默退化（不影响主流程）。
- `buildMcpActions(tools)`：把 `mcp__<server>__<tool>` 名字的动作路由到后端代理 `/llm/mcp/call`。

**后端 `mcp_manager.py`**：
- 每个 MCP server 一个**专属长驻 asyncio task** 持有 stdio 连接。
- 为什么不能直接缓存 session：mcp 2.x / anyio 把取消作用域绑死在创建它的 task 上，FastAPI 每请求不同 task，跨 task 复用会报 `Attempted to exit cancel scope in a different task`。
- 解法：外部调用通过 `asyncio.Queue` 投递给那个专属 task，结果用 `Future` 回传。
- 工具命名空间 `mcp__<server>__<tool>`（双下划线，因为 OpenAI 工具名不允许点号）。
- 配置在 `data/mcp_servers.json`，改完要重启后端。

---

## 4. 演变过程

### v0：正文 JSON 围栏（最初）

- 提示词让模型在正文里输出 ` ```json {"actions":[...]} ``` `。
- 前端 `parseReply` 抠围栏、逐条执行。
- **问题**：一次塞 12~20 个动作时输出太长，中途被截断 → 前面动作落盘、后面没跑，状态半途而废；历史消息越来越长但从没压缩。

### v1：截断修复（第一阶段）

四个根因一起修：

1. **截断即整轮作废** → 新增 `salvageTruncatedCalls()`，从被掐断的 JSON 里捞已写完的完整动作执行。
2. **`compressReply()` 写好没被调用** → 接入，历史不再无限膨胀。
3. **`MAX_ACTIONS_PER_ROUND = 8`** 硬批次上限。
4. 提示词规则强化（一次别写太多）。

验证：protocol 95 / runtime 24 / thinking 56 / image flow 36 全绿。

### v2：原生 function calling（方案 A）

把工具调用从「正文解析 JSON 围栏」换成 OpenAI 线格式：

- 请求带 `tools: [{type:'function', function:{name, description, parameters}}]` + `tool_choice: 'auto'`。
- 流式收集 `delta.tool_calls` 按 index 累积。
- 多轮遵循 `assistant.tool_calls` + `role: tool` 协议。
- JSON 围栏保留为兜底。
- 为全部 67 个工具手写 `TOOL_PARAMS` JSON Schema。
- `buildSystemPrompt` 加 `nativeTools` 模式（不再罗列说明书）。

**踩坑**：
- `chatStream`/`chatComplete`/`readSSE` 返回类型从 `string` 改成 `CompletionResult{content, toolCalls}`，所有 mock 同步改。
- `readSSE` 加第 6 个参数 `onToolCall`。

### v3：MCP 客户端宿主（方案 B）

- MCP client 必须放后端（stdio 要 spawn 子进程，浏览器做不到）。
- 每 server 一个专属长驻 task + Queue/Future 通信（见 3.7）。
- mcp 2.x 里 `FastMCP` 改名 `MCPServer`（`from mcp.server.mcpserver import MCPServer`）。
- 端到端验证：假 server `list_tools` → `call_tool` 返回 42。

### v4：工具名合规修复

**症状**：模型服务 400，`tools[0].function.name` 不匹配 `^[a-zA-Z0-9_-]+$`。

**根因**：67 个核心工具本来就是点号命名（`project.overview`、`web.search`…），OpenAI 兼容网关不允许点号。

**修法**：边界做翻译，不动内部注册——
- 线上发：`project_overview`、`web_search`。
- 派发前 `normalizeToolName` 译回 `project.overview`。
- MCP 工具用 `mcp__doubao__text_to_image`（双下划线）。

验证：67 个线上名零不合规；往返映射正确；protocol 103 / runtime 26 全绿。

### 演进路线图（未做）

- **方案 C：Yjs CRDT** 替换整项目 PUT，多人协同。大投入，未启动。
- **工具检索**：当前仍是 67 + MCP 全量下发。到 ~150~200 个工具时再上 BM25 轻量检索，核心工具永远全量。
- MCP server 图形管理 UI（目前只能手改 JSON + 重启）。

---

## 5. 关键设计决策

| 决策 | 理由 |
|---|---|
| 工具清单是单一数据源 | TOOL_SPECS 派生出说明书、Schema、自检，改一处全同步 |
| 纯函数协议层 + 副作用动作层分开 | 协议层可 100% 单测，动作层接 Dexie |
| 双路径（native + 文本兜底） | 模型不按 schema 来时不至于完全跑不动 |
| 截断不整轮作废 | 捞已写完的动作，写一半的丢，用户不丢进度 |
| MCP 连接放后端 + 每 server 专属 task | stdio 子进程只能在 Node/Python 侧；anyio task 绑定坑 |
| API Key 只存浏览器 IndexedDB | 本地优先原则，不经过后端落盘 |
| 工具名线上下划线、内部点号 | OpenAI 命名规范约束，内部代码可读性不动 |

---

## 6. 数据存哪

| 数据 | 位置 |
|---|---|
| LLM 配置（含 Key）、聊天记录、项目内容、撤销快照 | 浏览器 IndexedDB `card_arts` 库 |
| 素材文件本体 | 后端 `data/objects/<sha256 分片>` |
| SQLite 同步副本 | `data/card_arts.db` |
| MCP server 配置 | `data/mcp_servers.json` |
| 项目内容人类可读镜像 | 用户授权的本地文件夹（File System Access） |

---

## 7. 测试

| 文件 | 覆盖 |
|---|---|
| `test_agent_protocol.mjs` | 103：解析、抢救、Schema 一致性、说明书与实现对齐 |
| `test_agent_runtime.mjs` | 26：状态机、原生 function calling 端到端、分片 tool_calls 累积 |
| `test_thinking.mjs` | 56：推理模式切换 |
| `test_image_flow.mjs` | 36：图片生成流程 |

跑法：
```powershell
cd frontend
node test_agent_protocol.mjs   # 直接跑脚本，不用 node --test
npx tsc --noEmit
```
