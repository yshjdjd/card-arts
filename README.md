# CardArts

本地优先的卡牌与桌游设计工具，提供可视化版式编辑、卡牌数据管理、素材与字体库，以及能够直接操作工程的内置 Agent。适合制作武将牌、技能牌、道具牌和打印试玩原型。

支持浏览器开发模式与 Windows 便携桌面版。前端使用 React + TypeScript，后端使用 FastAPI，编辑数据先保存在本机。

**[完整使用手册](docs/CardArts完整使用手册.md)** · **[Agent 工具参数](docs/Agent工具参数.json)** · **[桌面与本机文件访问](docs/桌面模式与本机文件访问.md)**

## 主要功能

| 模块 | 当前能力 |
| --- | --- |
| 项目与牌组 | 示例工程、多牌组、字段定义、卡牌数据表、CSV / XLSX 导入导出、工程备份与版本快照 |
| 可视化版式 | 拖拽、缩放、旋转、对齐、吸附、参考线、精确尺寸、正反面编辑；支持在版式中编辑当前卡牌的绑定字段 |
| 图层管理 | 排序、隐藏、锁定、重命名、组合与解组；图层栏支持复选、Ctrl / Command 多选及 Shift 范围选择，组名可独立修改 |
| 形状与矢量 | 矩形、圆形、椭圆、三角形、六边形、盾牌、旗帜、箭头等预设；支持独立路径填充、描边与 SVG 路径导入 |
| 精细排版 | 富文本、内联图标、文字描边、竖排、自适应技能块、内容驱动高度、条件显示、字段绑定与重复图标槽位 |
| 组件与样式 | 共享样式、可复用组件、实例覆盖、自动布局、锚点、剪切组、纹理填充和材质预设；卡牌外工作区可用于组合素材 |
| 模板模块 | 内置卡牌版式模板、主题和尺寸；支持字段映射、应用模板，以及从当前版式保存项目模板 |
| 素材与字体 | 图片上传、文件夹整理、裁切、外链图片导入；内置 game-icons 图标搜索与导入；支持上传 TTF / OTF / WOFF / WOFF2 字体并设为项目默认或指定文字字体 |
| 项目文档 | Markdown 编辑与预览、可编辑表格文档、表格转卡牌 |
| 导出与打印 | PNG ZIP、卡牌数据、打印 PDF、A4 / Letter 排版、出血与裁切线、Tabletop Simulator 包 |
| 内置 Agent | 多会话、流式回复、模型与思考设置、计划与工具执行、上下文面板、压缩与历史检索、联网调研、外部 MCP 接入 |
| 桌面文件访问 | 用户手动授权目录后，Agent 可在该目录内进行基础文件操作及素材导入 |

## 快速开始

### Windows 便携桌面版

如果已有打包 ZIP，完整解压后运行 `CardArts.exe`，保留旁边的 `_internal` 目录。无需另外安装 Python 或 Node.js；运行环境需要 **Microsoft Edge WebView2 Runtime**，缺少时需从[微软官方页面](https://developer.microsoft.com/microsoft-edge/webview2/)安装。当前包不包含自动下载安装运行时的引导程序。

关闭原生窗口会同时停止本机服务。默认数据位置：

| 内容 | 路径 |
| --- | --- |
| 后端数据库、素材和日志 | `%LOCALAPPDATA%\CardArts\data\` |
| 桌面浏览器存储（包含 IndexedDB） | `%LOCALAPPDATA%\CardArts\webview\` |
| 用户连接的文件夹工作区 | 用户自己选择的目录 |

桌面版与原 Chrome / Edge 开发页面不共用浏览器存储。迁移工程时使用完整备份或连接已有文件夹工作区，核对恢复结果后再启用写回。升级前保留用户数据与工作区备份。

详见 [桌面模式与本机文件访问](docs/桌面模式与本机文件访问.md) 和 [便携版使用说明](packaging/windows/使用说明.txt)。

### 从源码运行

准备 Python、Node.js 和 npm，推荐使用独立 Python 虚拟环境。

Windows 可以双击根目录的 `start.bat`，启动开发后端（8000）和前端（5173）；`stop.bat` 用于停止这套开发服务。

也可以手动启动两个终端：

```bash
# 终端一：后端
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

```bash
# 终端二：前端
cd frontend
npm ci
npm run dev
```

打开 <http://localhost:5173>，API 文档位于 <http://127.0.0.1:8000/docs>。Vite 已将 `/api` 与 `/game-icons` 代理到后端。

### 从源码启动桌面服务

先安装上述依赖并构建前端：

```bash
npm --prefix frontend run build
python backend/desktop.py
```

Windows 也可在构建后运行 `start-desktop.bat`。源码入口默认在浏览器中打开桌面服务；终端按 Ctrl+C 退出。需要原生窗口时，安装桌面依赖后运行 `python backend/desktop.py --native`。

### 构建 Windows 便携包

在 Windows 项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File packaging/windows/build.ps1
```

脚本创建独立构建环境、安装锁定依赖、构建前端并运行 PyInstaller，输出：

- `release/CardArts/CardArts.exe`
- `release/CardArts-Windows-x64.zip`

构建依赖见 [requirements.lock.txt](packaging/windows/requirements.lock.txt)。生成的二进制、用户工程和密钥不纳入 Git。当前打包件未进行代码签名，完整的空白新电脑兼容性仍需验证。

## 推荐使用流程

1. 新建空白工程或打开示例工程，设置牌组尺寸和字段。
2. 输入或导入卡牌数据，上传图片、图标及所需字体。
3. 选择模板或手动编辑版式，把文字、图片和图标绑定到字段。
4. 在图层栏整理组合，将重复结构保存为组件或项目模板。
5. 切换不同卡牌，检查长文本、空图片、技能数量和打印边界。
6. 导出备份，再生成 PNG、打印文件或 TTS 包。

精细制作流程见 [精细设计系统与 Agent](docs/精细设计系统与Agent.md)，模板用法见 [卡牌模板模块](docs/卡牌模板模块.md)。

## 内置 Agent

打开项目内聊天窗（Ctrl+K），在模型设置中填写厂商、OpenAI 兼容接口地址、模型和 API Key。模型参数按项目配置；未启用远端模型时，仅提供有限的本地规则指令。

API Key 保存在本机浏览器设置中，不随工程同步上传。使用后端转发时，Key 会随请求传给所连接的后端，因此应使用可信后端。

### 工程操作与长任务

Agent 可访问项目、牌组、字段、卡牌、文档、素材、字体、模板、图层及精细设计操作；完整工具签名以 [Agent 工具参数](docs/Agent工具参数.json) 为准。

- 支持原生 function calling，并为兼容模型保留文本调用解析与异常格式恢复。
- 通过 `tools.discover` 按需加载工具，减少每轮发送的工具定义。
- 多步骤任务可维护待办、保存运行检查点，在继续对话时恢复目标和进度。
- 阶段预算会依据有效进展扩展；仍有总轮次、重复调用和失败保护，复杂任务可能需要继续执行。
- 只读工具可并行，写入工具串行；破坏性操作按会话权限确认。
- 聊天正文展示简洁结果，工具调用与参数在详情中查看。

可直接尝试：

> 先检查当前牌组与字段，用现有素材制作一个武将牌版式：左侧竖排姓名，中间插图，底部自适应技能区，右上角体力槽。优先复用模板和组件，不删除已有卡牌。完成后检查长文本溢出，并说明实际修改。

### 模型、思考与上下文

模型设置支持上下文容量与单次输出上限。已识别模型使用预设预算，未知模型或自建网关可以手动覆盖；预设不能保证与网关实际限制一致。

上下文面板展示预算构成、输出预留、安全余量及已挂载资料，提供压缩和历史检索。Token 数量包含估算，厂商返回的实际 usage 可用时单独记录。**上下文容量与单次最大输出是不同限制**，部分模型的推理 Token 也消耗输出额度。

思考开关按厂商和模型转换请求参数，实际可关闭与否取决于上游模型支持。详见完整手册的 Agent 章节。

### 联网搜索与调研

开启联网后，Agent 可使用：

- `web.search`：搜索相关网页。
- `web.fetch`：读取指定网页正文。
- `web.research`：组合搜索与多网页读取，返回资料及来源。

默认搜索通道为 DuckDuckGo，也支持配置 Tavily、Brave 或 Serper。联网开关表示允许使用工具；搜索是否成功仍取决于网络、搜索服务和 Key。天气等问题通过通用搜索与网页读取处理，没有专用天气工具。

### 本机文件

桌面模式下，在「设置 → 本机文件访问」中手动选择目录并设定只读或可写权限。Agent 使用 `files.roots` 与 `files.execute`，只能访问授权目录及相对路径，支持列目录、读取、写入、创建目录、复制、移动和导入素材。当前不支持任意覆盖、删除或执行文件，目录授权在服务重启后失效。

浏览器连接文件夹工作区与桌面 Agent 的目录授权是两套机制，不能相互替代。

## MCP 接入

CardArts 同时支持两个方向：

| 方式 | 用途 |
| --- | --- |
| 内置 Agent 连接外部 MCP | 在项目中配置外部服务器，让助手使用其提供的工具 |
| CardArts 作为 MCP 服务器 | 供外部客户端查询及修改后端已同步的工程、搜索图标、设置字体和管理图层 |

这两套工具的覆盖范围不同；外部 MCP 服务器不会直接读取尚未同步的浏览器 IndexedDB 工程，也不自动拥有桌面目录授权。

安装后端依赖后，以 stdio 启动：

```bash
cd backend
python -m app.mcp.server
```

外部客户端配置示例（具体字段以客户端支持为准）：

```json
{
  "mcpServers": {
    "cardarts": {
      "command": "python",
      "args": ["-m", "app.mcp.server"],
      "cwd": "<项目绝对路径>/backend"
    }
  }
}
```

使用虚拟环境时，将 `command` 改为该环境的 Python 绝对路径。若要访问桌面数据，需为 MCP 进程设置相同的 `CARDARTS_DATA_DIR`。

PowerShell 中启用 HTTP 传输：

```powershell
cd backend
$env:MCP_TRANSPORT = "streamable-http"
$env:MCP_PORT = "8765"
python -m app.mcp.server
```

MCP 默认监听 `127.0.0.1`。详见 [完整手册的 MCP 说明](docs/CardArts完整使用手册.md#MCP-的两种用法) 与 [图层管理与 MCP](docs/图层管理与MCP.md)。

## 数据保存与恢复

编辑操作先写入 IndexedDB，再通过同步队列发送到后端。离线可继续本地编辑，使用远端模型、搜索或未缓存素材时仍需要相应服务。

可选文件夹工作区把项目和素材镜像为真实文件：

```text
cardarts.json                     工作区索引
projects/*.json                   项目、牌组、卡牌、版式与文档
assets/                           素材原文件
assets/.assets.json               素材元数据
versions/                         版本快照
```

连接已有目录会先尝试恢复，核对项目列表后点击「立即落盘」开启写回。浏览器目录连接需要 File System Access API 支持和用户授权；不支持的环境可以使用工程备份导入导出。

**文件夹工作区、后端 data 目录和浏览器存储各有不同作用。** 迁移前应导出备份并保留素材；不要仅复制程序目录后就删除原用户数据。

## 配置与目录

| 配置 | 作用 |
| --- | --- |
| `CARDARTS_DATA_DIR` | 后端数据目录；开发模式默认根目录 `data/`，桌面模式默认用户数据目录 |
| `DATABASE_URL` | 数据库连接，默认 SQLite |
| `STORAGE_BACKEND` | 素材存储后端，默认 `local`，可配置 `s3`（需额外依赖及凭据） |
| `ICON_DIR` / `ICON_URL_PREFIX` | 内置图标目录与访问前缀 |
| `MCP_TRANSPORT` / `MCP_HOST` / `MCP_PORT` | 外部 MCP 服务传输方式、监听地址与端口 |
| `CORS_ORIGINS` | 开发模式允许的跨域来源 |
| `VITE_API_BASE` | 前端 API 地址，默认 `/api/v1`；修改后需重新构建 |

后端配置支持 `backend/.env`。桌面启动器只监听本机，使用会话认证，并将可变用户数据与程序资源分开。前端构建产物存在时，FastAPI 可同时托管页面与 API。

```text
backend/                  API、同步、素材、MCP 与桌面启动器
frontend/                 React 编辑器、内置 Agent 与本地存储
data/game-icons/          内置图标及授权说明
docs/                     使用手册与专题文档
packaging/windows/        Windows 构建脚本与锁定依赖
CardArts.spec             PyInstaller 配置
```

## 开发检查

```bash
npm --prefix frontend run build
npm --prefix frontend run test:agent
npm --prefix frontend run test:design
npm --prefix frontend run test:cardfields
npm --prefix frontend run test:documents
```

工作区恢复测试需从 `frontend` 目录运行：

```bash
cd frontend
node test_workspace_restore.mjs
```

后端回归测试从 `backend` 目录运行：

```bash
python -m unittest test_layers test_local_files test_web_tools -v
```

部分文件系统测试依赖操作系统权限，网络搜索与模型端到端行为需要在实际服务环境另行验证。

## 文档与素材许可

- [完整使用手册](docs/CardArts完整使用手册.md)
- [Agent 工具参数（JSON）](docs/Agent工具参数.json)
- [卡牌模板模块](docs/卡牌模板模块.md)
- [图层管理与 MCP](docs/图层管理与MCP.md)
- [版式内卡牌数据编辑](docs/版式内卡牌数据编辑.md)
- [精细设计系统与 Agent](docs/精细设计系统与Agent.md)
- [桌面模式与本机文件访问](docs/桌面模式与本机文件访问.md)

内置 game-icons.net 图标采用 **CC BY 3.0**，具体作者及许可见 [图标授权说明](data/game-icons/LICENSE.txt)。自备插画、字体和纹理请遵守各自许可。
