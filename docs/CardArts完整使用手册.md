# CardArts 完整使用手册

版本日期：2026-11-10。依据当前工作区实现编写，包含尚未提交的本地功能。部署旧版本时，界面可能与本手册不同。本文介绍产品操作，不保证任意第三方模型、网络服务或浏览器均可使用全部能力。

## 目录

1. [启动与基本概念](#启动与基本概念)
2. [项目、保存与恢复](#项目保存与恢复)
3. [牌组、字段与卡牌数据](#牌组字段与卡牌数据)
4. [素材、图标与字体](#素材图标与字体)
5. [版式编辑器](#版式编辑器)
6. [精细设计与武将牌制作](#精细设计与武将牌制作)
7. [文档、模板、导出与打印](#文档模板导出与打印)
8. [内置 Agent 完整用法](#内置-agent-完整用法)
9. [Agent 设计操作参数](#agent-设计操作参数)
10. [MCP 的两种用法](#mcp-的两种用法)
11. [故障排查与能力边界](#故障排查与能力边界)
12. [完整工具附录](#完整工具附录)

## 启动与基本概念

### Windows 启动

在项目根目录双击 `start.bat`。默认后端为 `http://127.0.0.1:8000`，前端为 `http://localhost:5173`。关闭使用 `stop.bat`。若修改前端但界面没变化，刷新页面；新增后端接口需要重启后端或启用开发热重载。

手动启动，在两个终端分别执行：

```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

```powershell
cd frontend
npm install
npm run dev
```

前端默认代理到 8000。后端 API 文档在 `http://127.0.0.1:8000/docs`。安装依赖需要网络；日常已有工程编辑以本地为主，网络搜索、模型、服务端素材等仍依赖对应服务。

### 数据关系

| 对象 | 含义 | 示例 |
| --- | --- | --- |
| 项目 | 一套设计工程 | 三国武将卡 |
| 牌组 | 共用字段与正反面版式的一批卡牌 | 武将牌、装备牌 |
| 字段 | 每张卡拥有的数据列 | 名称、体力、技能描述、插图 |
| 卡牌 | 一行实际数据 | 刘备，体力 4 |
| 图层／元素 | 版式里的文字、图片、图标、形状 | 姓名文本框、插画框 |
| 素材 | 图片、字体等资源 | 人物 PNG、金属纹理、字体文件 |
| 组件 | 可保存并插入的图层组合 | 技能块、费用角标 |
| 模板 | 版式、字段和配置的可复用方案 | 武将牌完整布局 |

**卡牌数据影响某张卡，版式影响整个牌组对应面。** 修改姓名字段与移动姓名文本框是两种不同操作。组件也不是模板：组件是局部组合，模板用于整张版式。

## 项目、保存与恢复

首页可新建空白或示例工程、导入工程、复制、删除和从后端拉取项目。进入项目后通过侧栏切换模块。

编辑先写浏览器 IndexedDB，再按同步机制推送后端。素材还可能保存在后端对象目录；单独复制浏览器地址不会复制工程。不要把关闭网页误认为数据丢失，也不要把浏览器缓存当作唯一备份。

### 推荐的保存流程

1. 开始设计后连接首页的“本地文件夹工作区”。
2. 定期在导出中心保存完整工程备份。
3. 大范围替换模板或调整字段前，保存版本快照或复制项目。
4. 换设备时验证工程和素材均可恢复，再清理旧环境。

文件夹工作区需要支持 File System Access API 的 Chromium 浏览器。连接文件夹后，项目、素材和版本会写入真实文件；恢复时选择同一目录并使用“从文件夹恢复”。浏览器可能要求重新授权文件夹访问。

后端数据默认在 `data/`，可通过 `CARDARTS_DATA_DIR` 指定目录。文件夹工作区、浏览器数据库、后端数据是不同存储层。JSON 备份是否包含素材本体，应以导出选项和恢复结果为准；需要完整迁移时同时备份素材与后端数据。

撤销／重做用于工程编辑；会话分支只复制对话上下文，不回滚项目。版本恢复、清空会话、删除项目也不是同一种操作。

## 牌组、字段与卡牌数据

在“牌组与字段”新建牌组，设置卡牌尺寸、共用牌背及字段。预设包括 poker、bridge、tarot、mini、euro、square；自定义宽高需要同时注意像素尺寸与实际毫米尺寸。

| 字段类型 | 建议用途 |
| --- | --- |
| text | 名称、称号、技能、规则文字 |
| number | 数量、费用、体力、体力上限 |
| image | 每张卡的不同插图，值为素材 ID |
| select | 阵营、稀有度、类别 |
| color | 按卡变化的背景色或文字色 |
| boolean | 是否启用某标识、是否显示某效果 |

在“卡牌数据”表格中录入、搜索和批量操作卡牌。CSV／XLSX 导入按表头匹配字段，建议先统一字段名称，再导入少量样本验证。`count` 数量影响导出份数，不应与游戏中的体力字段混用。

图片字段通过缩略图选择项目素材。不要直接填本机文件路径作为图片 ID。字段改类型或删除前，应检查绑定它的文字、显示条件和重复图标。

### 在版式中修改当前卡牌

选择样牌后，右侧“当前卡牌数据”可编辑字段；双击有字段绑定的图层可打开对应字段编辑。支持文本、数字、下拉、颜色、是否和图片。一个图层包含多个字段引用时，可切换要编辑的字段。

输入会立即用于预览并延迟提交；切卡或切版式时先提交。保存失败可重试；不要关闭页面后才期望内存中的失败草稿自动恢复。属性区“共享版式属性”修改的是公共设计。

## 素材、图标与字体

### 素材库

上传图片，按文件夹整理；可重命名、移动、查看详情和使用裁切功能。常见位图可作为素材，SVG 不是图片素材的唯一格式。图片能否解码仍取决于当前浏览器及后端支持。

拖图片到版式：落在插图框上可替换图片，落在空处可新建插图框。插图框可固定一张素材，也可绑定 image 字段。双击未绑定字段的图片可进入版式裁切；已绑定的图片优先走当前卡牌字段编辑，再调整此卡裁切。

### 内置图标库

内置库来自本地 `data/game-icons/` 中的 SVG 文件，可按名称、作者搜索，预览颜色与尺寸，再加入自建素材库或用于图标图层。新增图标资源后，需要按后端图标索引流程更新；仅上传 PNG 到素材库不会自动成为内置图标条目。

图标 ID 与项目素材 ID 是不同标识。Agent 应先查询现有资源，不应自行拼出一个图标或素材 ID。内置 Agent 的当前核心工具没有独立 `icon.search`；界面图标搜索、外部 MCP 图标搜索与 `asset.list` 不可混为一谈。

### 字体库

支持 TTF、OTF、WOFF、WOFF2；ZIP 可包含多个字体。导入后在字体库或文字属性中应用。字体作为项目素材使用，上传字体 key 形式为 `asset:素材ID`，由界面和 Agent 查询得到。

字体可用于预览、打印和导出。系统字体在另一台机器上不一定存在；要保证复现应使用可随工程加载的项目字体。使用前自行确认字体授权、中文覆盖和特殊符号是否完整。

## 版式编辑器

### 基本操作

1. 选择牌组、正面／背面和当前样牌。
2. 从工具栏添加文本、图片、图标或“形状／矢量”。
3. 在画布选择、拖动、缩放；右侧精确调整属性。
4. 在图层面板管理顺序、名称、组合、锁定和隐藏。
5. 用多个样牌检查字段长度和图片裁切。

| 操作 | 交互 |
| --- | --- |
| 打开 Agent | Ctrl+K |
| 多选 | Shift 点击，或空白处框选 |
| 组内单层选择 | Alt 点击 |
| 复制／粘贴 | Ctrl+C／Ctrl+V |
| 组合／解组 | Ctrl+G／Ctrl+Shift+G |
| 撤销／重做 | Ctrl+Z／Ctrl+Shift+Z |
| 微移 | 方向键；Shift 加大步长 |
| 平移视图 | 按住空格或鼠标中键拖动 |
| 缩放视图 | 工具栏加减；Ctrl／Cmd 加滚轮 |
| 临时绕过吸附 | 拖动时按 Alt |
| 回到卡牌 | “适应” |

输入框获得焦点时，常用编辑快捷键优先作用于文本。Mac 可使用对应 Command 组合。

### 卡牌外工作区

四周各增加 600 px 暂存区，可把图层移到牌外组合、制作组件。支持负坐标；工作区不是无限画布。导出仍按卡牌尺寸和出血规则裁切，牌外图层不会自动变成另一张卡。

### 字段绑定、条件与重复

文字可绑定 `fieldId`，也可用 `{字段ID}` 插值，例如 `费用：{cost}`。这里应使用字段 ID，不是随意填写的显示名称。

显示条件支持 equals、notEquals、gt、gte、lt、lte、contains、isEmpty、isNotEmpty，并可组成条件组。先用不同样牌验证条件。

数量展开按数字字段重复图层，支持横／纵方向和间距。体力显示还支持固定总格数、动态总格数字段、半格和空格透明度。动态总格数优先；0、缺失或无效值不显示。默认安全上限及用户设置的 `countMax` 会限制数量，最多 100 格。当前半格采用半边显示，不是另一张半格专用素材。

### 形状／矢量

统一入口包含基础形状、轮廓预设和 SVG 导入。预设包括矩形、圆角矩形、圆形、椭圆、线条、三角形、菱形、多边形、星形、箭头、盾牌、旗帜、缎带等。

导入支持纯路径 SVG：需要有效 viewBox；多条 path 合并为统一轮廓，统一由图层控制填充与描边。含文字、基础图形或 transform 的文件，请先在矢量软件中“转换为路径并应用变换”。当前不是完整 SVG 编辑器，没有节点／贝塞尔控制柄拖动功能。高级路径输入用于熟悉 SVG d 的用户。

## 精细设计与武将牌制作

### 文字排版

支持字体、字号、粗斜体、字距、行高、内边距、对齐、自动缩字和描边。文字方向可选横排、右起竖排或左起竖排。竖排支持自动换列、换行换列和富文本，字符保持直立；不具备专业日中竖排标点替换、英文自动旋转或避头尾规则。

富文本示例：

```text
**锁定技**：你造成的伤害增加 1。
[color=#b91c1c]红色提示[/color]
[size=32]重点文字[/size]
[icon:真实图标ID] [image:真实素材ID]
```

在绑定字段的文字上启用富文本会影响该版式所有卡牌的解析方式；具体内容仍来自各卡字段。

### 自适应技能块

在“设计系统”使用“添加自适应技能块”，生成名称、描述和底板。标题与正文可独立编辑，正文增高后底板跟随扩展。组合可整体移动，或保存为组件。

这不是任意深度嵌套容器。多个技能块之间不会凭空自动建立跨块流式关系；长技能仍需检查是否与其他块重叠、是否超出底部安全区。需要批量生成时让 Agent 明确设置位置、宽度、字号和绑定字段。

### 共享样式与组件

共享样式用于字体、颜色、描边等属性统一管理；局部修改会记录覆盖，后续同步默认保留。重置会清掉覆盖，应谨慎使用。

组件保存当前选中的图层组合，再插入新的实例。主定义更新后可同步实例；解除关联后成为独立图层。跨牌组插入时，所需字段 ID 必须存在。组件是当前实现的扁平组合，不等于完整嵌套容器系统。

### 自动布局与精确位置

设计系统可建立横／纵自动布局、设置间距和内边距、添加参考线、建立边缘／中心锚定，以及让文字随内容增高。像素／毫米的精确输入支持算式，例如 `10+2`。

自动布局和锚定会重新计算位置，手动拖动后若位置被重算，应先检查约束。解除约束前确认适用范围。裁切、模板缩放、组件局部覆盖等组合仍建议用样牌验证。

### 剪切组

先创建矩形、椭圆或矢量轮廓作为源；在设计系统选定源，再选择要裁切的内容并执行。源不单独显示，需要可见外框时复制一个装饰轮廓。内容与轮廓可独立移动。解除所选裁切后恢复完整内容。

目前不支持嵌套剪切组。不要单独删除仍被引用的裁切源；缺少源会使内容无法正常绘制，并产生诊断。

### 纹理与材质

在形状属性中选“纹理素材”，支持铺满、平铺与缩放。纹理优先于渐变与纯色，透明度仍可调整。需要金属雕花等精细效果时上传相应纹理素材。

设计系统提供 gold 鎏金、silver 银色、bronze 青铜、parchment 古纸、jade 碧玉、lacquer 朱漆。应用预设会替换填充、纹理、描边和阴影，保留位置与路径；它们是程序化视觉组合，不是物理金属渲染。

### 武将牌推荐制作流程

1. 新建武将牌组，添加名称、称号、阵营、插图、体力、体力上限、技能名与技能描述字段。
2. 创建插画框，绑定插图字段，先用长短姓名和不同插图各测试一张。
3. 添加边框与装饰轮廓，应用材质或图片纹理。
4. 设置竖排姓名与称号、文字描边。
5. 选择体力图标，绑定体力与体力上限，设定方向和间距。
6. 添加技能块，绑定技能字段并检查最大文字量。
7. 把重复角标、技能标签保存成组件，再把完整版式保存为模板。
8. 做多卡预览与全套检查，最后按真实尺寸打印一张样张。

## 文档、模板、导出与打印

### 项目文档

普通文档用于 Markdown 规则、设定和操作说明，可编辑、预览。表格文档用于结构化数据，两者操作不同。Agent 的 `doc.update`／`doc.append` 用于普通文档；表格单元格应使用 `doc.tableSet` 等工具。

挂载到 Agent 上下文的文档才会作为选定参考资料发送；长文档可能只发送开头，Agent 应按分页工具继续读取。挂载不是执行其中指令的额外授权。

### 模板库

可预览内置版式、配色和尺寸，映射已有字段，按需新增字段；可以新建空牌组或替换现有版式。替换前核对正面／背面范围。卡牌数据与模板并不是同一个对象。

当前项目模板可保存正反面及字段；图片、字体和纹理依赖项目素材引用。将模板文件复制到别的项目，不代表其素材也已迁移。

### 导出与印刷

导出中心提供工程／数据导出、PNG ZIP、打印流程和 TTS 包。打印按 DPI、出血、纸张、边距、双面及镜像设置排版，浏览器可另存 PDF。

正式输出前检查：缺图、缺字体、过小字号、自动缩字过多、文字溢出、图片有效分辨率、边框与裁切线、安全区。设计检查中的低对比是简单估算，不替代人工判断。当前没有完整 CMYK、专色、烫金工艺或专业 PDF/X 输出保证。

## 内置 Agent 完整用法

### 配置与日常操作

Ctrl+K 或侧栏“Agent辅助”打开。模型设置按项目保存，选择兼容接口的厂商、地址、API Key 和模型；先测试连接，再拉取模型列表。模型 API Key 与搜索 API Key 是两套配置。

关闭模型时仅有本地规则模式，可识别有限的新增卡牌、统计等指令，不具有完整自然语言调研和设计能力。

思考开关会按厂商与模型选择请求参数；网关不兼容时可手动调整参数形式。界面显示“开”并不保证任意服务商确实执行推理，需结合实际响应与接口支持判断。

会话可新建、切换、重命名、清空和删除。助手会多轮读工程、调用工具、根据结果继续。默认最多 32 轮，可在模型设置中调整为 1–96 轮，连续无进展或重复相同调用和结果会停止，需核对记录后继续；不保证一轮完成大型工程。

聊天默认简短显示最终答复；思考过程、上下文用量和执行记录单独折叠。执行记录是判断工具是否真正成功的依据，不能仅凭“已完成”三个字判断结果。

### 如何下达有效需求

推荐写清目标、牌组、正反面、数据范围、视觉约束与验收条件：

> 先读取武将牌组的字段和正面图层。为每张卡绑定名称、称号和插图；姓名使用右起竖排，保留现有字体。添加一个技能块并绑定已有技能名和描述字段。不要修改牌背。最后检查所有卡的文字溢出。

> 先查素材与字体。把正面边框应用鎏金材质；只改边框，不改插图。列出受影响图层后执行。

> 为体力图标绑定“体力”和“体力上限”两个数字字段，允许半格，空格透明度 0.2，横向间距 6。若字段不存在先询问，不要自行推断现有数据。

> 联网调研常见武将牌的信息层级，至少读取三个可访问来源，区分实际读到的正文和搜索摘要，给出来源后再建议本项目如何调整。

### 工具权限与运行机制

| 级别 | 默认行为 |
| --- | --- |
| read | 自动执行；独立只读调用可并行 |
| write | 自动执行工程写入，串行处理 |
| destructive | 默认请求确认；可按会话授权 |

批量替换、删除、组件重置等要仔细核对范围。`project.setSetting` 等通用设置工具应说明具体 key 与目的，不建议随意修改内部结构。

Agent 可读取真实 ID 后操作；普通定位多支持 ID、名称或序号。图层管理的 `ids`、组件、模板、来源 ID 等应以列表返回的真实值为准。原生 function calling 在请求中把点号转换成下划线，如 `element_update`；用户自然语言无需写这些名称。

### 上下文、Token 与压缩

“上下文”页面包含容量面板、最近请求和下一轮预览、历史与摘要管理、文档／知识包挂载、联网和授权设置。

- 上下文容量是输入和输出共享的模型窗口；最大输出 Token 是单次回复上限。
- 输入预算要扣除输出预留与安全余量（当前安全余量为 1024 Token）。预留不是固定会产生的用量。
- 自动容量优先采用当前接口模型元数据，再采用程序中匹配的模型预设，未知模型回退 64K；手动覆盖优先。模型预设是代码内置估值，不是对网关能力的实时验证。
- 输出自动档根据模型、思考设置和接口上限选择；手动值仍受模型输出上限约束。调大输出不会修复网络断开或服务商截流。
- 自动压缩默认阈值按容量约 60% 计算；也可手动压缩或取消。失败时保留原历史。
- 历史原文与长工具结果可通过会话工具分页读取，摘要不是删除原记录。
- “从此处分支”创建对话分支，不复制成一个独立工程，也不回滚当前设计。

停止按钮会取消正在进行的模型请求及传递了取消信号的工具；已经成功写入的修改不会自动撤销。重新继续时应先让 Agent 核对工程状态。

### 联网与调研

在上下文启用联网，选择搜索通道，必要时填写搜索 Key，并使用“检测搜索连接”。“允许联网”表示权限，不代表网络连通。



网页读取不执行 JavaScript，不解析 PDF／图片；研究工具也不是无限深度浏览器。长结果归档后按 `conversation.readResult` 继续读，不能把预览当全文。后端代理可用 `CARDARTS_HTTP_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 配置，改环境变量后重启后端。

## Agent 设计操作参数

统一调用结构：

```json
{"tool":"design.execute","args":{"deck":"真实牌组ID","side":"front","operation":"skill.create","args":{"title":"仁德","body":"技能效果","x":60,"y":650,"width":620,"fontSize":26}}}
```

上例是内部协议示意，日常直接说自然语言即可。以下 `ids` 为真实元素 ID 数组，`side` 为 `front` 或 `back`。

| operation | args 与用途 |
| --- | --- |
| skill.create | title、body、titleField?、bodyField?、x?、y?、width?、fontSize?；创建名称／描述／自适应底板 |
| material.apply | ids、material；gold/silver/bronze/parchment/jade/lacquer |
| clip.create | ids、source；把内容裁进真实形状／路径源，禁止嵌套 |
| clip.release | ids；解除所选裁切 |
| style.save | name、properties 或 ids、style?；新增或更新共享样式 |
| style.apply | ids、style；应用共享样式 |
| style.reset | ids、style；重置覆盖，需确认 |
| style.detach | ids；解除样式关联 |
| component.save | ids、name、component?；保存／更新组件 |
| component.insert | component、x?、y?；插入实例 |
| component.sync | component；同步保留局部覆盖 |
| component.reset | component；重置实例覆盖，需确认 |
| component.detach | ids；解除实例关联 |
| layout.anchor | ids、horizontal:left/right/center/stretch、vertical:top/bottom/center/stretch |
| layout.flow | ids、direction:horizontal/vertical、gap?、padding?、x?、y?、width?、align? |
| layout.grow | ids、maxHeight、image?、minImageHeight?；文字撑高，可压缩指定插图 |
| layout.clear | ids；解除所选约束／流布局，区别于清空整个版式的 layout.clear 工具 |
| layout.guide | axis:x/y、value；或 clear:true |
| element.precise | ids、x?、y?、width?、height?、unit:px/mm；支持算式字符串 |
| text.snippet.save | name、text；保存富文本片段 |
| text.snippet.insert | ids、snippet；插入静态文字，绑定字段请改卡牌数据 |

### 常用 element.update 属性

| 分类 | patch 属性 |
| --- | --- |
| 坐标 | x、y、width、height、rotation |
| 文字 | text、fieldId、fontFamily、fontSize、minFontSize、maxFontSize、autoFit、richText、fontWeight、fontStyle、lineHeight、letterSpacing、padding、paragraphSpacing、firstLineIndent、horizontalAlign、verticalAlign |
| 方向 | writingMode:horizontal/vertical-rl/vertical-lr |
| 外观 | fill、color、fillOpacity、textOpacity、borderColor、borderWidth、borderOpacity、borderStyle、borderRadius、gradient:{from,to,angle}、shadow:{color,blur,x,y}、blendMode |
| 纹理 | textureAssetId、textureMode:cover/repeat、textureScale>0 |
| 路径 | shapePath:SVG d、pathViewBox:[x,y,width,height] |
| 图片 | assetId、imageFit、imageZoom、imageFocusX、imageFocusY、imageMask、maskPath |
| 重复／体力 | countFieldId、countMax、countSpacing、countDirection、countSlots、countSlotsFieldId、countHalf、countEmptyOpacity |

剪切关系、技能块和组件建议用专用设计操作创建，不要通过任意字段写入绕过引用校验。`font.set` 的默认范围可能是全项目，务必给 deck／side／element 限定范围。

## MCP 的两种用法

### 内置 Agent 调用外部 MCP

这是让项目助手使用另一个 MCP 服务器提供的工具。后端发现工具后转为模型可调用的函数，界面工具数量可能超过核心工具数量。远程工具通常有 `mcp__…` 前缀，权限与可用性由连接配置和远程服务共同决定。

外部 MCP 接口失败时，内置核心工具仍可使用。不要把“已允许联网”当成外部 MCP 已连接。具体远程工具参数以服务器声明为准，本手册的核心工具表不包括未知远程扩展。

### 把 CardArts 启动为 MCP 服务器

从 `backend` 目录启动：

```powershell
python -m app.mcp.server
```

这是 stdio 模式，通常由外部 MCP 客户端拉起；不要把它当普通聊天命令输入网页。

HTTP 模式在 PowerShell 中执行：

```powershell
$env:MCP_TRANSPORT='streamable-http'
$env:MCP_PORT='8765'
python -m app.mcp.server
```

客户端 stdio 配置示意（将路径改为实际安装路径，Python 使用已安装依赖的环境）：

```json
{
  "mcpServers": {
    "cardarts": {
      "command": "python",
      "args": ["-m", "app.mcp.server"],
      "cwd": "D:/workbuddy_pro/2026-10-16-19-15-55/card_arts/backend"
    }
  }
}
```

**两套工具不完全等价。** 外部 MCP 服务器操作后端已经保存／同步的项目；网页 Agent 主要通过浏览器工程状态编辑。外部客户端使用前先同步，修改后在网页核对同步与版本冲突。

内置 `design.execute` 的所有新功能并未自动成为同名外部 MCP 工具。外部客户端应先列出服务工具，再按其真实 schema 调用。不要用内置 Agent 的 `card.add` 参数直接套在外部的 `add_card` 上。外部图层操作及并发版本参数可另读《图层管理与MCP》。

## 故障排查与能力边界

| 现象 | 处理 |
| --- | --- |
| 只回答、没有改工程 | 展开执行记录；确认启用模型、模型支持工具调用，要求先读取工程再执行 |
| 停在请求前 | 检查后端；素材清单有 8 秒超时与本地回退，停止可取消已传递信号的请求 |
| 开联网仍查不到 | 检测通用搜索通道；检查运行后端机器的网络、代理、通道 Key |
| 工具结果很短 | 找归档 ref，分页读取；不要反复重跑写入工具 |
| 回复截断 | 查看结束原因、输出上限、思考占用与网络错误；缩小单批任务 |
| 历史很长 | 用容量面板核对实际请求，压缩并固定关键约束，必要时读取原历史 |
| 改一张卡却全部变化 | 检查是否改了共享版式属性，而不是卡牌字段值 |
| 自动布局拖完回弹 | 位置仍受流布局或锚定控制；调整约束或解除后再移动 |
| 体力条不显示 | 检查数字字段 ID、总格数 0、显示条件与 countMax |
| 图片／纹理缺失 | 检查素材是否在当前项目、是否已上传同步、素材 ID 是否正确 |
| 剪切后消失 | 检查源是否存在、尺寸是否有效、内容与源是否相交 |
| 字体变回默认 | 字体未加载、字体 key 错误或该字体不含所需字符 |
| 导出与编辑观感不同 | 检查出血、DPI、字体加载、样牌与卡片级裁切；牌外暂存区不会作为成品输出 |

尚未实现的重点能力：任意深度嵌套容器、专业矢量节点编辑、完整 SVG/CSS 解析、嵌套剪切组、专业竖排标点、完整印刷色彩管理。现有功能不可等同于 Photoshop／Illustrator／InDesign。

当前自动回归与组合浏览器案例能够覆盖部分行为，不构成所有浏览器、字体、素材、网关和印刷设备的完整认证。正式印刷前必须人工核对样张。

## 完整工具附录

完整 JSON Schema 参数表：[Agent工具参数.json](Agent工具参数.json)。包含 name、wireName、level、description、parameters 及 required 字段。设计子操作的 args 目前是通用对象，具体字段仍需结合上文“Agent 设计操作参数”使用。维护者可在 frontend 运行 `node export_agent_reference.mjs` 重新生成。

下面从当前 `frontend/src/lib/agentProtocol.ts` 的 `TOOL_SPECS` 自动提取，避免漏列核心工具。参数名与实现版本对应；定位前先读取列表。只读、写入、危险的含义见上文，个别操作会按运行时参数升级为危险操作。

### `tools.discover` · 只读

`tools.discover {query?,names?[]}`：按分类关键词或精确工具名检索并加载工具，下一轮获得参数。分类 project/deck/field/card/element/layout/layer/design/template/doc/asset/font/web/conversation；每次最多 8 项。

### `project.overview` · 只读

project.overview {} → 读取项目全貌（牌组/字段/卡牌/版式/文档/设置的真实 id）

### `project.rename` · 写入

project.rename {name} → 改项目名

### `project.setExport` · 写入

project.setExport {dpi?,bleedMm?,duplex?,flipOnBack?,cutLines?,pageSize?} → 改导出/打印设置

### `project.setSetting` · 写入

project.setSetting {key,value} → 改任意项目设置（如 lang、syncEnabled）

### `deck.list` · 只读

deck.list {} → 列出所有牌组

### `deck.create` · 写入

deck.create {name,preset?,width?,height?,layout?} → 新建牌组；preset 可选 poker/bridge/tarot/mini/euro/square

### `deck.rename` · 写入

deck.rename {deck,name} → 牌组改名

### `deck.delete` · 危险

deck.delete {deck} → 删除牌组

### `deck.duplicate` · 写入

deck.duplicate {deck,name?} → 复制牌组

### `deck.setSize` · 写入

deck.setSize {deck,preset|width/height} → 改牌组卡牌尺寸

### `deck.setSharedBack` · 写入

deck.setSharedBack {deck,value} → 是否共用牌背

### `field.list` · 只读

field.list {deck} → 列出字段（含 id）

### `field.add` · 写入

field.add {deck,name,type?,options?,showInTable?,default?} → 新增字段；type 可选 text/number/image/select/color/boolean

### `field.rename` · 写入

field.rename {deck,field,name} → 字段改名

### `field.setType` · 写入

field.setType {deck,field,type,options?} → 改字段类型

### `field.setOptions` · 写入

field.setOptions {deck,field,options[]} → 改下拉选项

### `field.delete` · 危险

field.delete {deck,field} → 删除字段（同时清掉卡牌上的值）

### `card.list` · 只读

card.list {deck,limit?,offset?} → 列出卡牌（默认 30 条）

### `card.find` · 只读

card.find {deck,query} → 按任意字段值搜索卡牌

### `card.add` · 写入

card.add {deck,name?,values?} → 新增一条卡牌，values 用字段名或字段 id 作 key

### `card.addMany` · 写入

card.addMany {deck,items:[{name,...values}]} → 批量新增

### `card.update` · 写入

card.update {deck,card,values:{字段:值}} → 改一条卡牌

### `card.set` · 写入

card.set {deck,card,field,value} → 改一条卡牌的单个字段

### `card.batchSet` · 写入

card.batchSet {deck,field,value} → 整个牌组某字段统一赋值（如全部数量=2）

### `card.batchFill` · 写入

card.batchFill {deck,items:[{card,values}]} → 按卡逐条批量改

### `card.delete` · 危险

card.delete {deck,card} → 删除卡牌

### `card.duplicate` · 写入

card.duplicate {deck,card,n?} → 复制卡牌

### `design.catalog` · 只读

design.catalog {} → 查询项目共享样式、组件ID、修订版本、字段需求和自动布局

### `design.execute` · 写入

design.execute {deck,side,operation,args:{...}} → 体力显示用element.update patch设置countFieldId为真实数字字段、countMax上限、countSlots固定总格数、countSlotsFieldId绑定总格数数字字段（优先，0不显示）、countHalf:true支持半格、countEmptyOpacity:0-1控制空格。精细设计。operation: material.apply(ids,material:gold/silver/bronze/parchment/jade/lacquer) 对形状应用材质，替换填充纹理描边阴影； clip.create(ids,source) 用真实矩形/椭圆/路径元素裁切所选图层，源不单独显示；clip.release(ids)解除；暂不支持嵌套。 skill.create(title,body,titleField?,bodyField?,x?,y?,width?,fontSize?) 创建带自适应底板的技能块； style.save(name,properties,style?更新)/style.apply(style,ids)/style.reset(style,ids)/style.detach(ids)；component.save(name,ids,component?更新并同步)/component.insert(component,x?,y?)/component.sync(component)/component.reset(component)/component.detach(ids)；layout.anchor(ids,horizontal:left/right/center/stretch,vertical:top/bottom/center/stretch)/layout.flow(ids,direction:horizontal/vertical,gap?,padding?,x?,y?,width?,align?)/layout.grow(ids,maxHeight,image?,minImageHeight?)/layout.clear(ids)/layout.guide(axis:x/y,value或clear:true)。element.precise(ids,x?,y?,width?,height?,unit:px/mm)支持四则算式精确排版；text.snippet.save(name,text)保存规则片段；text.snippet.insert(ids,snippet)插入静态文本。先查询真实ID。共享更新影响全项目；局部覆盖默认保留。component.reset会丢弃全部实例覆盖，需确认。文字方向用element.update patch设置writingMode:horizontal/vertical-rl/vertical-lr；竖排中英文均为直立字形，borderColor/borderWidth设文字描边。形状纹理用element.update patch设置textureAssetId（先asset.list取得真实图片ID）、textureMode:cover/repeat、textureScale:正数；纹理优先于渐变和纯色。效果用element.update patch设置padding/paragraphSpacing/firstLineIndent/inlineIconScale/inlineIconOffset/gradient:{from,to,angle}/shadow:{color,blur,x,y}/imageMask:ellipse或rectangle/maskPath:0-100坐标SVG路径/blendMode。

### `design.preflight` · 只读

design.preflight {deck,side} → 渲染全牌组并检查溢出、小字号、缩字过多、低分辨率图片、低对比、缺失素材及样式/组件/字段引用，返回定位ID；不会修改工程

### `template.list` · 只读

template.list {query?} → 查询内置与本项目保存的版式模板；返回真实 id、用途和字段需求

### `template.inspect` · 只读

template.inspect {template,deck?,theme?,preset?,side?,mapping?} → 只读预览版式、字段绑定和将新增的字段；theme:parchment/midnight/minimal；preset 用尺寸预设；side:front/back/both；mapping 为模板字段id到已有字段id

### `template.create` · 写入

template.create {template,name?,theme?,preset?,side?} → 按模板新建空牌组，不改现有牌组；先 list/inspect；使用真实模板id

### `template.apply` · 危险

template.apply {template,deck,theme?,preset?,side?,mapping?} → 替换现有牌组指定面的版式，保留卡牌和字段，可撤销；先 inspect 核对字段映射并确认替换范围

### `template.save` · 写入

template.save {deck,name} → 将牌组正反面和字段保存为项目模板，供界面与Agent复用；素材引用依赖本项目

### `layer.list` · 只读

layer.list {deck,side} → 列出顶层到底层的真实图层 ID、序号、组、锁定和隐藏状态

### `layer.manage` · 写入

layer.manage {deck,side,operation,ids,target?,name?,order?,expandGroups?} → 管理图层；operation: front/back/up/down/above/below/order/rename/show/hide/lock/unlock/group/ungroup；先 layer.list；ids 使用真实 ID；order 为完整底层到顶层 ID 数组；锁定层需先 unlock；默认操作整组，expandGroups:false 可单层操作；above/below 用 target ID

### `element.list` · 只读

element.list {deck,side} → 列出某面版式的元素（side: front|back）

### `element.add` · 写入

element.add {deck,side,kind,x,y,width,height,name?,fieldId?,text?,fill?,color?,fontSize?,fontFamily?,richText?} → 新增元素；kind 可选 text/image/icon/rectangle/ellipse/line/path

### `element.update` · 写入

element.update {deck,side,element,patch:{...}} → 改元素任意属性（x/y/width/height/fill/color/fontSize/fieldId/…）

### `element.move` · 写入

element.move {deck,side,element,x,y} → 移动

### `element.resize` · 写入

element.resize {deck,side,element,width,height} → 改尺寸

### `element.style` · 写入

element.style {deck,side,element,fill?,color?,borderColor?,borderWidth?,borderRadius?,fontSize?,fontFamily?,fontWeight?,horizontalAlign?,verticalAlign?} → 改样式

### `element.rename` · 写入

element.rename {deck,side,element,name} → 元素改名

### `element.bind` · 写入

element.bind {deck,side,element,fieldId} → 绑定字段（留空解除）

### `element.condition` · 写入

element.condition {deck,side,element,field,op,value|conditions[],mode,clear} → 显示条件；op: equals/notEquals/gt/gte/lt/lte/contains/isEmpty/isNotEmpty

### `element.countExpand` · 写入

element.countExpand {deck,side,element,fieldId?,max?,spacing?,direction?,slotsField?,slots?,half?,clear?} → 数量展开（按某字段重复绘制）

### `element.delete` · 危险

element.delete {deck,side,element} → 删除元素

### `layout.setBackground` · 写入

layout.setBackground {deck,side,color?,assetId?} → 改版式背景

### `layout.setBorder` · 写入

layout.setBorder {deck,side,color?,width?,radius?} → 改版式边框

### `layout.setSize` · 写入

layout.setSize {deck,side,preset|width/height} → 改版式画布尺寸

### `layout.clear` · 危险

layout.clear {deck,side} → 清空该面所有元素

### `doc.list` · 只读

doc.list {} → 列出文档

### `doc.create` · 写入

doc.create {title,content} → 新建一篇 Markdown 文档（content 不能为空；要建表格用 doc.createTable）

### `doc.update` · 写入

doc.update {doc(必填),title?,content?} → 整篇改写；目标必须是普通文档，表格文档请改用 doc.tableSet

### `doc.append` · 写入

doc.append {doc(必填),content} → 末尾追加；目标必须是普通文档，表格文档请改用 doc.tableAddRow

### `doc.delete` · 危险

doc.delete {doc(必填)} → 删除文档

### `doc.read` · 只读

doc.read {doc(必填),offset?,limit?} → 按字符分页读文档；offset 从 0 起，默认读 2500 字符；按返回的 nextOffset 继续，表格可用 doc.tableRead

### `conversation.readResult` · 只读

conversation.readResult {ref,offset?} → 分页读取当前会话保存的完整工具结果

### `conversation.search` · 只读

conversation.search {query} → 搜索本会话原始历史，返回消息 id 与摘录

### `conversation.readTurn` · 只读

conversation.readTurn {id,offset?} → 分段读取历史原文；压缩后需核对早期要求时使用

### `font.list` · 只读

font.list {} → 列出系统字体与项目已上传字体（key、名称）；使用前先查，不能编造字体 key

### `font.set` · 写入

font.set {font,deck?,side?,element?,setDefault?} → 设定字体；font 用 font.list 返回的 key 或精确名称；有 element 时只改该文字；有 deck 时改该牌组，否则改项目全部文字；side: front/back/both，默认 both；setDefault:true 同时设为新建文字默认字体

### `asset.list` · 只读

asset.list {limit?,kind?} → 列出素材库（kind=image/font 可只看图片或字体）

### `asset.import` · 写入

asset.import {url,name?} → 由后端抓取外链图片存进素材库，返回可直接使用的素材 id

### `asset.use` · 写入

asset.use {asset,deck?,side?,element?,name?,x?,y?,width?,height?,imageFit?} → 把素材放进版式：给 element 就替换该插图框的图，否则新建插图框

### `asset.rename` · 写入

asset.rename {asset,name} → 素材改名

### `asset.delete` · 危险

asset.delete {asset} → 删除素材

### `doc.createTable` · 写入

doc.createTable {title,header[],rows?[][]} → 新建一篇表格文档

### `doc.tableRead` · 只读

doc.tableRead {doc,limit?,offset?} → 读表格文档（返回 Markdown 表格）

### `doc.tableFind` · 只读

doc.tableFind {doc,query,column?} → 在表格里按关键词搜行

### `doc.tableStats` · 只读

doc.tableStats {doc} → 表格概况：行列数、列名、空值统计

### `doc.tableSet` · 写入

doc.tableSet {doc,row,column,value} → 改一个单元格（row 从 1 起，column 用列名或 A/B/C 序号）

### `doc.tableAddRow` · 写入

doc.tableAddRow {doc,values?[]|object} → 追加一行

### `doc.tableAddColumn` · 写入

doc.tableAddColumn {doc,name,values?[]} → 追加一列

### `doc.tableDeleteRow` · 危险

doc.tableDeleteRow {doc,row} → 删除一行

### `doc.tableToCards` · 写入

doc.tableToCards {doc,deck,mode?} → 把表格导入成卡牌（mode: append|replace）

### `web.search` · 只读

web.search {query,maxResults?} → 联网搜索，返回标题/网址/摘要

### `web.research` · 只读

web.research {query,maxPages?} → 网络调研：搜索并并行读取最多 5 个来源的正文，返回来源网址、时间、正文及各来源失败原因；可继续追问检索和交叉核对


### `web.fetch` · 只读

web.fetch {url,offset?,limit?,maxChars?} → 分页抓取网页正文；默认每页 2500 字符，按 nextOffset 继续；最多抓取 120000 字符

### `todo.write` · 写入

todo.write {items:[{text,status}]} → 建立或更新待办清单（status: pending|in_progress|done）

## 相关专题文档

- [版式编辑与字体使用](版式编辑与字体使用.md)
- [版式内卡牌数据编辑](版式内卡牌数据编辑.md)
- [精细设计系统与Agent](精细设计系统与Agent.md)
- [卡牌模板模块](卡牌模板模块.md)
- [图层管理与MCP](图层管理与MCP.md)
- [Agent长会话与恢复](Agent长会话与恢复.md)
- [Agent联网调研与天气](Agent联网调研与天气.md)

本完整手册以当前界面和代码为依据；旧专题中的工具数量、默认额度和界面名称若有差异，优先以当前实现及本手册说明为准。

## 长任务运行机制更新（2026-11-10）

当前任务会保存目标、规划／执行／验收阶段、轮次和最近工具。发送单独的“继续”可沿用原目标；它基于保存历史核对工程后继续，而不是重复执行同一个内存现场。刷新后不会在无人交互下自动消费模型额度。

运行中接近预算时，发送给模型的较早长工具结果可缩略，完整检查点保留；这属于工具结果缩略，不是 Codex 原生上下文压缩，也不保证任何规模的任务都能装入窗口。

模型尝试最终回答时，系统检查会话待办；有未完成项会要求核对一次，仍未完成则标为受阻。这是待办一致性检查，不是完整视觉验收，也不能代替 design.preflight 或人工样张检查。运行预算仍有硬上限，不会自动无限扩张。

### 阶段预算更新

用户设置的执行轮数是硬上限。运行器先使用不超过 16 轮的阶段预算，阶段结束仍有成功且未重复的工具结果时，可每次续接最多 8 轮，始终不超过硬上限。空结果、失败和重复结果不会为本阶段续接提供依据。此信号只代表工具层进展，不保证任务质量或视觉效果。

任务详情展示阶段预算和硬上限。普通解释性回答不会因旧会话待办尚未勾完而被强行继续；已有工程操作或恢复任务仍会进行待办完成检查。

### 图层栏精确多选

无需在画布框选：勾选各行左侧复选框即可选择多个图层，再点击上方“组合”。Ctrl／Command 点击切换所选图层；Shift 点击按当前可见列表顺序连续选择；Alt 点击可选择组内单层。提供“全选可见项”和“取消选择”。搜索过滤或折叠时，Shift 范围按可见条目计算，默认组选择仍会带上同组成员。组合至少需要两个图层；锁定图层请先解锁。

## Token 优化更新：按需工具与精简快照

运行时不再每轮默认携带完整工具集合。初始只提供少量基础工具和任务相关工具，模型调用 `tools.discover {query,names}` 后，在后续请求获得匹配工具的参数定义。query 建议使用英文分类或精确名称；一次最多加载 8 项，可以多次查询。外部 MCP 工具也可发现，关闭联网时内部 web 工具不会被加载。已加载的工具在本次运行中保留，新任务重新按需加载。

此实现是客户端普通 function calling 路由，不依赖 OpenAI 专用 tool_search 接口。完整工具清单仍可查询，权限规则不因工具发现而改变。

系统工程快照仅保留工程索引；字段、卡牌、图层、素材、字体详情通过工具获取。任务记忆减少历史摘录和执行事实重复；原历史和完整检查点仍保留。

上下文面板显示实际请求的已加载工具；下一轮预览按当前输入推断初始工具，后续工具发现会改变集合。新增本次任务累计已报告输入与输出 Token，缺少 usage 的请求不当作实际零用量，摘要请求单独计费且未纳入此累计。实际费用仍以服务商账单为准。


联网说明修正：天气仅是通用联网测试例子；没有专用天气工具。天气等实时问题必须通过 web.search、web.fetch 或 web.research 核对来源。检测搜索连接不代表所有网页均可访问。

### 组名称

组名独立于成员图层名。图层栏组标题旁点击铅笔可重命名；旧组合默认显示“未命名组”。Agent 和外部 MCP 可用 renameGroup 操作，ids 传同一组的成员，name 为组名；重命名不会修改成员名称，锁定成员需先解锁。

## 本机文件与桌面启动更新

详见[桌面模式与本机文件访问](桌面模式与本机文件访问.md)。新增 files.roots、files.execute；总计 84 个核心工具。用户需先在设置页通过原生选择器授权目录，Agent 才能进行相对路径文件操作和导入素材。新桌面模式使用会话认证与独立用户数据目录；不是已经完成 EXE 打包。
