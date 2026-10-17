/** 前后端共享的核心数据模型（后端整体存为 JSON 文档，前端用同一套结构）。 */

export type FieldType = 'text' | 'number' | 'image' | 'select' | 'color' | 'boolean';

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  options?: string[];
  /** select 类型每个选项绑定的图标 */
  optionIcons?: Record<string, { id: string; color: string }>;
  showInTable?: boolean;
  defaultValue?: unknown;
}

export interface Card {
  id: string;
  values: Record<string, unknown>;
  layoutOverrides?: Record<string, Partial<LayoutElement>>;
}

export type ElementKind = 'text' | 'image' | 'icon' | 'rectangle' | 'ellipse' | 'line';

export type CompareOp = 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isEmpty' | 'isNotEmpty';

export interface Condition {
  type: 'comparison';
  fieldId: string;
  operator: CompareOp;
  value: unknown;
}

export interface ConditionGroup {
  type: 'group';
  operator: 'all' | 'any';
  conditions: AnyCondition[];
}

export type AnyCondition = Condition | ConditionGroup;

export type WrapMode = 'none' | 'word' | 'anywhere' | 'keepWord';

export interface LayoutElement {
  id: string;
  kind: ElementKind;
  name: string;
  x: number; y: number; width: number; height: number; rotation: number;
  fill: string; color: string;
  fillOpacity?: number; textOpacity?: number; borderOpacity?: number;
  borderColor?: string; borderWidth?: number;
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  borderRadius?: number;
  fieldId?: string;
  fontFamily?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  text?: string; fontSize?: number; maxFontSize?: number; minFontSize?: number;
  autoFit?: boolean; lineHeight?: number; letterSpacing?: number;
  wrapMode?: WrapMode;
  horizontalAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  imageFit?: 'cover' | 'contain';
  imageZoom?: number;
  imageFocusX?: number;
  imageFocusY?: number;
  richText?: boolean;
  groupId?: string;
  assetId?: string;
  iconId?: string;
  /** 顶层既可以是单个条件，也可以是条件组 */
  displayCondition?: AnyCondition;
  locked?: boolean; hidden?: boolean;
  /** 数量展开：按某字段的值重复绘制（原项目核心机制之一） */
  countFieldId?: string;
  countMax?: number;
  countSpacing?: number;
  countDirection?: 'horizontal' | 'vertical';
}

export interface Layout {
  id: string;
  name: string;
  width: number;   // px @300DPI
  height: number;
  /** 物理尺寸 mm，仅用于导出 / 打印 */
  widthMm?: number;
  heightMm?: number;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  backgroundAssetId?: string | null;
  elements: LayoutElement[];
}

export interface Deck {
  id: string;
  name: string;
  fields: Field[];
  cards: Card[];
  frontLayout: Layout | null;
  backLayout: Layout | null;
  /** 牌背：所有牌共用一张 */
  useSharedBack?: boolean;
}

/** 表格文档的结构化数据（来自 xlsx / xls / csv 导入，或手工建表） */
export interface TableData {
  /** 表头列名 */
  header: string[];
  /** 数据行；每行长度与 header 对齐（缺失补空串） */
  rows: string[][];
  /** 原工作簿里的 sheet 名（多 sheet 导入时用于区分） */
  sheet?: string;
}

/**
 * 项目文档。
 *
 * 两种形态并存，是为了让模型既能"读"也能"精确改"：
 *   - markdown：自由文本，content 即正文；
 *   - table：结构化表格，content 是自动生成的 Markdown 表格（给人看 / 给模型快速扫），
 *            table 才是数据本体，改单元格走 doc.tableSet 这类工具。
 */
export interface ProjectDocument {
  id: string;
  title: string;
  /** 默认 markdown，向后兼容旧数据 */
  kind?: 'markdown' | 'table';
  content: string; // Markdown（table 类型时为渲染出的表格）
  table?: TableData;
  /** 导入来源，便于追溯 */
  source?: { name: string; size?: number; importedAt: string; sheets?: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface ExportSettings {
  dpi: number;
  bleedMm: number;
  duplex: boolean;
  flipOnBack: boolean;
  cutLines: boolean;
  pageSize: 'A4' | 'Letter';
}

export interface ProjectSettings extends Record<string, unknown> {
  lang?: 'zh' | 'en';
  syncEnabled?: boolean;
  export?: ExportSettings;
}

export interface ProjectContent {
  decks: Deck[];
  documents: ProjectDocument[];
  settings?: ProjectSettings;
}

export interface LocalProject {
  id: string;
  name: string;
  content: ProjectContent;
  baseRevision: number;
  dirty: boolean;
  localRevision: number;
  remoteId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at?: string;
}

export interface RemoteAsset {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  kind: 'image' | 'font';
  mime: string;
  size: number;
  sha256: string;
  variants: Record<string, { key: string; size: number; mime: string }>;
  meta: {
    width?: number; height?: number; dominant_color?: string;
    icon_id?: string; icon_author?: string; icon_color?: string; source?: string;
  };
  url: string;
  thumb_url?: string | null;
  created_at?: string;
}

export interface LocalAsset {
  id: string;
  projectId: string;
  name: string;
  kind: 'image' | 'font';
  mime: string;
  size: number;
  sha256: string;
  blob?: Blob;
  remoteId?: string;
  folderId?: string | null;
  state: 'local-only' | 'synced' | 'failed';
  createdAt: string;
}

export interface IconItem {
  id: string;
  name: string;
  author: string;
  url: string;
}

/* ---------------- 大模型与会话 ---------------- */

/**
 * 各家「思考 / 推理」能力的开关方式五花八门，没有统一字段：
 *   model            —— 换模型名（DeepSeek：deepseek-chat ⇄ deepseek-reasoner）
 *   reasoning_effort —— OpenAI o 系列：reasoning_effort: low / medium / high
 *   enable_thinking  —— 通义千问 Qwen3：enable_thinking: true / false
 *   thinking_object  —— 智谱 GLM：thinking: { type: 'enabled' | 'disabled' }
 *   budget           —— Anthropic / OpenRouter：thinking: { type:'enabled', budget_tokens: N }
 *   template         —— 自建网关通用写法：chat_template_kwargs: { enable_thinking: true }
 */
export type ThinkingKind =
  | 'model'
  | 'reasoning_effort'
  | 'enable_thinking'
  | 'thinking_object'
  | 'budget'
  | 'template';

export interface ThinkingSpec {
  kind: ThinkingKind;
  /** kind==='model'：开启思考时切到的模型名（如 deepseek-reasoner） */
  model?: string;
  /** kind==='model'：关闭思考时回退的模型名（如 deepseek-chat） */
  baseModel?: string;
  /** 支持强度档位（reasoning_effort = low/medium/high；budget = 具体 token 数） */
  efforts?: string[];
  /** 该厂商思考模式的注意点，展示在开关下面 */
  hint?: string;
}

/** 内置厂商预设：都走 OpenAI 兼容的 /chat/completions */
export interface LLMProvider {
  key: string;
  label: string;
  /** 兼容 OpenAI 的 base，形如 https://api.openai.com/v1 */
  baseUrl: string;
  models: string[];
  /** 该厂商是否允许浏览器直连（否则必须走后端代理） */
  corsOk?: boolean;
  hint?: string;
  /** 思考模式怎么开 */
  thinking?: ThinkingSpec;
}

export interface LLMConfig {
  /** Actual model context capacity (input + output). Defaults to 65536 for old settings. */
  contextWindow?: number;
  enabled: boolean;
  /** 厂商 key；custom 表示完全自定义 */
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  /** true = 请求经由本地后端转发（规避跨域，密钥不出本机） */
  useProxy: boolean;
  /** 是否开启深度思考 / 推理模式 */
  thinking?: boolean;
  /** 思考强度：reasoning_effort 用 low/medium/high；budget 用数字字符串 */
  thinkingEffort?: string;
  /** Anthropic 系的思考预算（token） */
  thinkingBudget?: number;
  /** 自建网关可能和预设不一样，允许手动指定参数形式；不填则按厂商/模型名自动判断 */
  thinkingKind?: ThinkingKind;
  /** kind==='model' 时，记住开启思考前的模型名，关掉后能切回来 */
  thinkingBaseModel?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  agentRun?: {
    status: string;
    records: import('./agentProtocol').ToolRecord[];
  };
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** 该条是否触发了工程改动 */
  mutated?: boolean;
  /** 模型输出的思考过程（开启思考模式时才有，单独折叠展示） */
  reasoning?: string;
}

/** 一条待办（仿 Claude Code 的 TodoWrite） */
export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** 一份可挂载进提示词前缀的知识包（内置或用户自定义） */
export interface SkillDef {
  key: string;
  name: string;
  desc: string;
  /** 注入提示词前缀的正文 */
  body: string;
  /** 内置包不可删除 */
  builtin?: boolean;
  /** 是否默认勾选 */
  defaultOn?: boolean;
}

/**
 * 会话级上下文：决定哪些文档 / 知识包会被拼进系统提示词前缀。
 * 存在会话上，所以每个会话可以有自己的"参考资料"。
 */
export interface AgentContext {
  /** 挂载的文档 id */
  docIds: string[];
  /** 挂载的知识包 key */
  skills: string[];
  /** 自定义知识包（项目级，随项目文档同步） */
  customSkills?: SkillDef[];
  /** 允许联网（web.search / web.fetch） */
  web?: boolean;
  /** 搜索引擎通道：auto / duckduckgo / wikipedia / tavily / brave / serper */
  webProvider?: string;
  /** 对应通道的 key（tavily / brave / serper 需要） */
  webApiKey?: string;
  /** 已放行的危险工具（本次会话内不再弹确认） */
  approved?: string[];
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  messages: ChatMessage[];
  /** 覆盖项目级模型（空则跟随项目配置） */
  modelOverride?: string;
  /** 上下文挂载 + 待办 + 授权 */
  context?: AgentContext;
  todos?: TodoItem[];
  createdAt: string;
  updatedAt: string;
}
