# CardArts

本地优先（local-first）的卡牌 / 桌游设计工具，前后端分离架构。
由 `lab.ludloom.com` 的功能逆向分析后**完整重写**，项目名由 Ludloom 改为 **CardArts**。

```
card_arts/
├── backend/           Python FastAPI 后端（同步 / 素材 / 图标库 / MCP）
├── frontend/          React + TypeScript 前端（完整编辑器）
├── data/              服务端数据根目录（SQLite + 对象存储 + 内置图标库）
└── workspace/         浏览器直连的文件夹工作区（项目 / 素材 / 版本的真实文件）
```

---

## 快速开始

### 0. 一键启动 / 一键关闭（Windows）

双击项目根目录的脚本即可：

- `start.bat` —— 检查环境与依赖，分别在独立窗口启动后端（8000）和前端（5173），
  等待服务就绪后自动打开浏览器；已在运行的端口会跳过。设置环境变量
  `CARDARTS_NO_BROWSER=1` 可不自动开浏览器。
- `stop.bat` —— 关闭上述两个服务窗口、清理残留进程，并确认 8000 / 5173 已释放。

也可在终端中执行 `cmd /c start.bat` 与 `cmd /c stop.bat`。

### 1. 后端

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

启动后：

- API 文档：<http://127.0.0.1:8000/docs>
- 内置图标库：<http://127.0.0.1:8000/game-icons/delapouite/sword-altar.svg>
- 数据库：`data/card_arts.db`（SQLite，可换 Postgres）
- 对象存储：`data/objects/`（内容寻址，sha256 去重）
- 图标库：`data/game-icons/`（4239 个 SVG）
- 数据根目录可用环境变量 `CARDARTS_DATA_DIR` 改到别处

### 2. 前端

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

`vite.config.ts` 已把 `/api` 与 `/game-icons` 代理到 8000。

---

## 功能清单

### 项目与数据

| 模块 | 能力 |
| --- | --- |
| 首页 | 新建（空白 / 示例工程）、导入 `.cardarts.json`、复制、删除、备份、从云端拉取 |
| 牌组与字段 | 多牌组；字段增删改排序、6 种类型（文本/数字/图片/下拉/颜色/是否）、选项管理、是否在表格显示；6 种卡牌尺寸预设；版式复制到其他牌组 |
| 卡牌数据表 | 内联编辑、搜索、批量复制/删除、CSV / XLSX 导入（表头自动匹配字段）与导出 |
| 版式编辑器 | 6 种元素（文本/图片/图标/矩形/椭圆/线条）、拖拽移动与四角缩放、图层排序/锁定/隐藏、属性面板、**字段绑定 `{id}`**、**显示条件**（可嵌套条件组）、**数量展开**、样牌切换、撤销 |
| 素材库 | 文件夹树、拖拽上传（秒传 / 分片 / 断点续传 + 进度）、重命名、移动、删除、服务端裁切（按卡牌预设 / 自定义尺寸）、详情（尺寸/主色/sha256） |
| **内置图标库** | 4239 个 game-icons.net 图标（CC BY 3.0）；搜索（名称/作者）、分页、颜色预览、尺寸预览、多选、**加入自建素材库文件夹并重命名**（支持名称模板 `{name}/{author}/{index}` 与逐个改名、着色、重名策略） |
| 项目文档 | Markdown 编辑 / 分栏预览 |
| 版本历史 | 服务端快照保存与恢复 |
| 导出中心 | 完整备份 JSON、卡牌数据 JSON/CSV/XLSX、PNG 打包 ZIP（Worker 并发渲染，含出血）、打印 PDF、Tabletop Simulator 包（单 ZIP / 每牌组一个 ZIP） |
| 打印页 | A4/Letter 排布、边距/间距/DPI、双面 + 背面镜像、裁切线、浏览器打印另存 PDF |
| **AI 助手** | 悬浮聊天窗（Ctrl+K）；**每个项目独立配置大模型**（厂商 / 接口地址 / 模型 / API Key / 温度 / 系统提示），兼容任意 OpenAI 接口；**项目内多会话**（新建 / 切换 / 重命名 / 删除 / 清空），可流式输出并直接改工程 |
| 其他 | 浅色/深色主题、中英语言、离线可用、自动同步状态指示 |

---

## 本地优先是怎么做的

1. **所有写入先落 IndexedDB（Dexie）**，再进 `outbox` 队列；离线照常编辑。
2. 联网后 `sync.ts` 顺序回放队列：`push-project` / `upload-asset`。
3. **乐观并发**：项目带 `baseRevision` + `localRevision`，`PUT /projects/{id}/sync` 不匹配返回 409。
   冲突时本地更新则强制覆盖，否则采用服务端内容并把本地旧版另存为「冲突副本」——**绝不丢数据**。
4. **素材内容寻址**：`storage_key = sha256[:2]/sha256[2:4]/sha256+ext`，相同字节只存一份，天然秒传。
5. 撤销/重做：每次写操作前把 `content` 快照压入 `history` 表（保留最近 60 步）。

---

## 文件夹工作区：把数据写成真实文件

IndexedDB 里的数据看不见摸不着，清缓存就丢。**文件夹工作区**让项目、素材、版本
变成工作目录下一组可以直接查看、git 归档、拷贝备份的文件。

在首页「本地文件夹工作区」点 **连接文件夹…**，选 `card_arts/workspace`（或任意目录）：

```
cardarts.json                      索引清单
projects/{名称}-{id8}.json          项目全文（牌组 / 卡牌 / 版式 / 文档）
assets/{文件夹}/{文件名}             素材原文件，按界面里的文件夹树直存
assets/.assets.json                素材元数据（id / sha256 / 尺寸 / 主色）
versions/{项目}/{序号}-{标签}.json    最近 30 条版本快照
```

- 运行时仍以 IndexedDB 为主，文件夹是它的持久化镜像，改动后约 1 秒自动写回；
- 素材按 sha256 判断，内容没变就跳过下载和写盘；
- 换机器 / 清缓存后，重新连接同一目录点 **从文件夹恢复** 即可读回；
- 需要 Chromium 内核浏览器（File System Access API）；Safari / Firefox 请用导出中心的完整备份。

---

## 项目内大模型与多会话

每个项目都能单独配一套模型参数，互不影响。打开聊天窗（Ctrl+K）→「模型设置」：

| 项 | 说明 |
| --- | --- |
| 厂商 | OpenAI / DeepSeek / 通义千问 / Kimi / 智谱 GLM / 硅基流动 / 火山方舟 / OpenRouter / Ollama / 自定义 |
| 接口地址 | 任意 OpenAI 兼容的 `{base}/chat/completions`，可填自建网关（One-API、New API、LiteLLM） |
| 模型 | 从预设选，或点「拉取列表」读远端 `/models`，也可手填 |
| API Key | 只存在本机浏览器，不写进项目文档、不随同步上传 |
| 温度 / 最大 Token / 系统提示词 | 逐项目可调 |
| **思考模式开关** | 一个开关适配各家写法，见下节 |
| 经由本地后端转发 | 推荐开启：走 `POST /api/v1/llm/chat`，规避跨域，密钥只在本机后端流转 |

### 思考模式（深度推理）

各家「开思考」的字段完全不统一，界面上只暴露一个开关，具体参数由 `src/lib/llm.ts`
按 **厂商预设 → 模型名 → 兜底** 的顺序推断，上层不用关心：

| 厂商 | 实际发出的参数 |
| --- | --- |
| DeepSeek | 换模型名 `deepseek-chat` ⇄ `deepseek-reasoner`（已是 `deepseek-v4-pro` 时改用 `thinking:{type:'enabled'}`） |
| OpenAI o 系列 | `reasoning_effort: low / medium / high` |
| 通义千问 Qwen3 | `enable_thinking: true / false` |
| 智谱 GLM / 豆包 / Kimi K2 | `thinking: { type: 'enabled' / 'disabled' }` |
| Claude / OpenRouter | `thinking: { type:'enabled', budget_tokens: N }` |
| Kimi K3 | `reasoning_effort: low / high / max` |
| 自建网关 | `enable_thinking` + `chat_template_kwargs`（可在界面手动改参数形式） |

几个已经踩平的细节：

- **思维链占用输出额度**。DeepSeek 的 `reasoning_content` 最多能到 32K，和正文共用
  `max_tokens`。开启思考时会自动把「最大 Token」抬到 16384，并给出提示——
  否则思维链先把配额吃光，正文和工具 JSON 反而被截断。
- **超出模型自身上限会被厂商 400**。`deepseek-chat` 的输出上限只有 8K，
  所以会在发出前按模型夹住（界面上有提示），不会让用户撞这个错。
- **思考模式下不发 `temperature`**（o 系列传了会 400，DeepSeek 传了也不生效）。
- **思考过程单独展示**：`reasoning_content` / `reasoning` 增量单独收集，
  在消息里折叠成「思考过程」，不混进正文。

会话：左侧列表可新建任意多个会话，各自保留完整历史；切换 / 重命名 / 删除 / 清空。
重新打开聊天窗会回到最近一次会话，**不会**自动新建一个空会话。
未启用模型时是本地规则引擎，仍能听懂「新增一张卡牌 XXX」「把数量改成 2」「统计一下」这类指令。

### 模型可以直接操作整个工程

启用模型后，助手不是只能聊天——它能调用 **63 个工具**直接改工程
（`src/lib/agentTools.ts` 实现，`src/lib/agentProtocol.ts` 负责解析与调度）：

| 分类 | 工具 |
| --- | --- |
| 项目 | `project.overview` `project.rename` `project.setExport` `project.setSetting` |
| 牌组 | `deck.list` `deck.create` `deck.rename` `deck.delete` `deck.duplicate` `deck.setSize` `deck.setSharedBack` |
| 字段 | `field.list` `field.add` `field.rename` `field.setType` `field.setOptions` `field.delete` |
| 卡牌 | `card.list` `card.find` `card.add` `card.addMany` `card.update` `card.set` `card.batchSet` `card.batchFill` `card.delete` `card.duplicate` |
| 版式元素 | `element.list/add/update/move/resize/style/rename/bind/condition/countExpand/delete`、`layout.setBackground/setBorder/setSize/clear` |
| 文档 | `doc.list` `doc.create` `doc.update` `doc.append` `doc.read` `doc.delete` |
| 结构化表格 | `doc.createTable` `doc.tableRead` `doc.tableFind` `doc.tableStats` `doc.tableSet` `doc.tableAddRow` `doc.tableAddColumn` `doc.tableDeleteRow` `doc.tableToCards` |
| 联网 | `web.search` `web.fetch` |
| 计划 | `todo.write` |
| 素材 | `asset.list` `asset.rename` `asset.delete` |

工作流程：

1. 每轮请求都会重建前缀：**工程真实快照**（牌组 id、字段 id、元素 id、前 12 条卡牌、导出设置）
   + 已挂载的知识包 + 已挂载的文档 + 当前待办；
2. 模型需要改工程时输出一个 JSON 代码块：`{"actions":[{"tool":"card.add","args":{...}}]}`；
3. 前端按分级执行，把每条的成败回传给模型，最多再走 3 轮让它自我修正；
4. 执行结果同时显示在对话里（`🔧 执行 N 个动作`），用户看得见改了什么。

定位参数（牌组 / 字段 / 卡牌 / 元素）都支持 id、名称、名称子串、序号（1 起），模型写错也能兜住。
工具名还支持 `addCard` 这类写法自动纠正成 `card.add`。

### 仿 Claude Code 的三件事

**1. 权限分级**（`ToolSpec.level`）

| 级别 | 行为 | 例子 |
| --- | --- | --- |
| `read` | 自动放行，连续多条**并行**跑 | `project.overview` `card.list` `doc.tableRead` `web.*` |
| `write` | 自动放行，**串行**落库，避免互相踩踏 | `card.add` `element.update` `doc.tableSet` |
| `destructive` | 弹窗确认；可选「本次会话都允许」，清单存在会话上下文里可随时撤销 | `deck.delete` `card.delete` `layout.clear` `doc.tableDeleteRow` |

工具结果超过 4000 字会自动截断，防止长列表把上下文撑爆。

**1b. 模型跑偏成别的调用格式时的兜底**

DeepSeek 系列偶尔会不按协议来，直接吐它自己训练的原生标签式调用
（`<｜DSML｜｜invoke name="…">`）。以前这种输出会被整段丢弃 —— 表现为
「模型说要改，但一条都没执行」，还会在聊天里留下一串乱码。现在三层兜底：

1. **预防**：系统提示词里明确禁止 XML / DSML / `<tool_call>` 式语法，精简模式也保留这条；
2. **抢救**：DSML 写得完整时直接解析成工具调用执行（半角 `|` 和全角 `｜` 都认）；
3. **纠正**：解析不出来（比如 `args` 被吐成 `true` 这种残缺值）时不静默结束，
   而是回一句「你用了不支持的格式，请用 JSON 代码块重发」，让它当场改正；
   同时把那串标签从展示文本里清掉，用户不再看到乱码。

**2. 可勾选的上下文（提示词前缀）** —— 聊天窗 →「上下文」

- **知识包**：内置 6 个（卡牌数值平衡、PnP 打印规范、版式规格、图标用法、导出指南、助手工作守则），
  可自建「自定义知识包」写进项目里随项目走；
- **项目文档**：勾选哪篇就拼哪篇（Markdown 与表格都行），超长自动截断；
- **联网开关**：关闭时提示词里明确告诉模型「不要用 web.*」；开启时可选搜索引擎通道
  （默认 DuckDuckGo，无需 Key；也支持 Tavily / Brave / Serper）；
- **`@` 提及**：输入框里打 `@` 会弹出文档 / 知识包列表，选中即自动挂载，比切面板更快。

**3. 联网**（后端代跑，绕开浏览器跨域）

```
POST /api/v1/web/search   {query, provider?, api_key?, max_results?, lang?}
POST /api/v1/web/fetch    {url, max_chars?}
```

抓取会自动剥掉 script/style、优先取 `<article>/<main>`、剔除页脚噪声并截断。
典型用法：模型先 `web.search` 找网址，再 `web.fetch` 读正文，然后按查到的规则改牌——不会凭记忆编造。

**4. 待办**：多步骤任务会先用 `todo.write` 列计划，界面上方实时显示 `[x] 完成 / [~] 进行中 / [ ] 待办`。

自检：`node frontend/test_agent_protocol.mjs`（92 项，含分级 / 并行 / 授权 / 截断 / DSML 兜底 / 上下文挂载 /
「说明书与实现一一对应」校验）、`node frontend/test_thinking.mjs`（56 项，思考模式各厂商参数）。

### 流式输出

代理通道会把上游 SSE **原样透传**给前端逐字渲染（不再等整段聚合完才出字）。
后端 `POST /api/v1/llm/chat` 带 `stream: true` 时返回 `text/event-stream`；
上游报错时也会补一条 `[DONE]` 收尾，前端不会干等。
自检：`python backend/test_llm_stream.py`（19 项，含「首个分片很快到达」、
思考参数透传、o 系列字段改名、`reasoning_content` 回传验证）。

后端代理接口：

```
POST /api/v1/llm/chat     转发对话（OpenAI 兼容，stream=true 时透传 SSE）
POST /api/v1/llm/test     探活 + 顺便列出可用模型
POST /api/v1/llm/models   拉取远端模型列表
```

后端不保存任何 api_key，每次请求由前端带回。

### 结构化表格文档

「文档」页现在能上传 **`.xlsx / .xlsm / .xls / .csv / .json`**（以及 `.md/.txt`）：

- xlsx 多 sheet 会拆成多篇文档，各自保留 sheet 名；
- 表格文档在页面里是**可编辑网格**（改表头 / 改单元格 / 加行 / 加列 / 删行），并能导出 CSV / XLSX；
- 对模型是**双表示**：`doc.tableRead` 返回 Markdown 表格便于快速扫，
  `doc.tableSet/tableFind/tableStats/tableToCards` 用来精确改和批量导入卡牌。

---

## 图标库新增接口

```
GET  /api/v1/icons/stats                     图标库统计
GET  /api/v1/icons/authors                   作者列表（含数量）
GET  /api/v1/icons?q=&limit=&offset=&author=&color=   检索（返回 total 便于分页）
GET  /api/v1/icons/{icon_id}/svg?color=&size= 单图标预览（颜色烘进 SVG）
GET  /game-icons/{author}/{name}.svg         静态原图
POST /api/v1/icons/import                    加入自建素材库（可改名/指定文件夹/着色）
POST /api/v1/icons/import-batch              批量加入（名称模板）
```

`import` 请求体：

```json
{
  "project_id": "...",
  "icon_id": "delapouite/sword-altar",
  "name": "长剑祭坛",          // 可选，自动补 .svg
  "folder_id": null,           // 目标文件夹
  "color": "#e11d48",          // 可选，烘进 SVG
  "on_conflict": "rename"      // rename | skip | replace
}
```

---

## MCP 智能体

```bash
cd backend
python -m app.mcp.server                      # stdio
MCP_TRANSPORT=streamable-http MCP_PORT=8765 python -m app.mcp.server
```

客户端配置：

```json
{
  "mcpServers": {
    "cardarts": {
      "command": "python",
      "args": ["-m", "app.mcp.server"],
      "cwd": "<绝对路径>/card_arts/backend"
    }
  }
}
```

提供：项目索引 Resource、工程概览 Resource、21 个工具（建牌组 / 改字段 / 批量写卡牌 / 搜图标 / 改版式 / 上传素材等）、2 个 Prompt 模板。

---

## 环境变量（backend/.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CARDARTS_DATA_DIR` | `<card_arts>/data` | 数据根目录（数据库 / 对象存储 / 图标库） |
| `DATABASE_URL` | `sqlite+aiosqlite:///.../card_arts.db` | 可换 Postgres |
| `STORAGE_BACKEND` | `local` | `local` / `s3` |
| `UPLOAD_CHUNK_SIZE` | 4 MiB | 分片大小 |
| `UPLOAD_MAX_SIZE` | 2 GiB | 单文件上限 |
| `ICON_DIR` / `ICON_URL_PREFIX` | `data/game-icons` / `/game-icons` | 内置图标库 |
| `MCP_TRANSPORT` / `MCP_PORT` | `stdio` / 8765 | MCP 服务 |
| `CORS_ORIGINS` | `http://localhost:5173,...` | 跨域 |

前端（`.env`）：`VITE_API_BASE` —— 后端不在 8000 同源时用。大模型参数已改为在项目内配置，不再需要环境变量。

---

## 备注

- 原 `ludloom-next/` 是改名前的骨架版本，已被本目录取代，可忽略。
- 图标版权：game-icons.net，CC BY 3.0（`data/game-icons/LICENSE.txt`）。
- 想整体搬迁：拷走 `data/`（服务端数据）+ `workspace/`（文件镜像）即可，或设置 `CARDARTS_DATA_DIR`。
