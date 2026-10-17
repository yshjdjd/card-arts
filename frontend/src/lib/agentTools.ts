/**
 * 项目内 AI 助手的「工具箱」。
 *
 * 设计目标：把 CardArts 的**全部工程能力**（牌组 / 字段 / 卡牌 / 版式元素 /
 * 文档 / 素材 / 导出设置）暴露成一组命名动作，让大模型能像函数调用一样精确操作工程，
 * 而不是只能聊天。
 *
 * 模型侧协议（写进系统提示词）：
 *   需要改工程时输出一个 JSON 代码块：
 *     ```json
 *     {"actions":[{"tool":"card.add","args":{"deck":"主牌组","name":"火焰箭"}}]}
 *     ```
 *   不需要改工程时正常说话即可。
 *   解析 / 执行 / 提示词拼装这些纯逻辑在 agentProtocol.ts（可单测）。
 */
import { api } from '../api/client';
import { db, defaultFields, emptyLayout, uid } from '../db/schema';
import { FONTS, presetByKey } from './presets';
import { fontKey } from './fontIdentity';
import { selectEntity, textPage } from './agentData';
import type { AgentAction, AgentActions, ToolCall } from './agentProtocol';
import type {
  AnyCondition, CompareOp, Deck, Field, FieldType, Layout, LayoutElement,
  ProjectContent, ProjectDocument, TableData, TodoItem,
} from './types';

export * from './agentProtocol';

/* ------------------------------------------------------------------ */
/* 上下文与基础工具                                                     */
/* ------------------------------------------------------------------ */

export interface AgentCtx {
  projectId: string;
  projectName: string;
  update: (fn: (c: ProjectContent) => void, label?: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** 是否开放联网工具（会话上下文里的开关） */
  web?: boolean;
  /** 搜索通道：duckduckgo / wikipedia / tavily / brave / serper */
  webProvider?: string;
  /** 对应通道的 key（tavily/brave/serper 需要） */
  webApiKey?: string;
  /** 写回会话待办 */
  setTodos?: (todos: TodoItem[]) => void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 素材读取                                                            */
/* ------------------------------------------------------------------ */

/** 智能体眼里的素材：id 可直接作为 image 元素的 assetId / 图片字段的值 */
export interface AgentAsset {
  id: string;
  name: string;
  kind: 'image' | 'font';
  mime: string;
  size: number;
  /** 可直接打开的 URL；本地未同步的素材为空 */
  url: string;
}

/**
 * 素材真正的存放位置是服务端，本地 IndexedDB 里只有「还没同步上去的那些」。
 * 以前工具只读 db.assets，于是用户明明传了一堆图，智能体看到的却是空库，
 * 只能凭空编 assetId。这里改成和界面同一份：优先服务端清单，失败再退本地。
 */
const assetCache = new Map<string, { at: number; items: AgentAsset[] }>();
const ASSET_TTL = 20_000;

export async function listProjectAssets(
  ctx: { projectId: string },
  opts: { force?: boolean } = {},
): Promise<AgentAsset[]> {
  const cached = assetCache.get(ctx.projectId);
  if (!opts.force && cached && Date.now() - cached.at < ASSET_TTL) return cached.items;

  const local = await db.projects.get(ctx.projectId);
  const remoteId = local?.remoteId ?? ctx.projectId;
  let items: AgentAsset[] = [];
  try {
    const r = await api.listAssets(remoteId);
    items = (r.items ?? []).map((a) => ({
      id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size ?? 0, url: a.url,
    }));
  } catch {
    items = [];
  }
  if (!items.length) {
    // 离线或还没推过服务端：用本地那份（含尚未同步的）
    const rows = await db.assets.where('projectId').equals(ctx.projectId).toArray();
    // 本地素材还没 URL（本体是 blob），界面靠 blob 显示，智能体知道 id 就够用了
    items = rows.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size ?? 0, url: '',
    }));
  }
  // 本地刚传上去、还没进服务端清单的也要带上，否则刚拖进来的图智能体看不见
  const known = new Set(items.map((a) => a.id));
  try {
    const pending = await db.assets.where('projectId').equals(ctx.projectId).toArray();
    for (const a of pending) {
      if (known.has(a.id)) continue;
      items.push({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size ?? 0, url: '' });
    }
  } catch { /* 表不存在时忽略 */ }

  assetCache.set(ctx.projectId, { at: Date.now(), items });
  return items;
}

/** 素材改动后立刻失效缓存 */
export function invalidateAssets(projectId: string): void {
  assetCache.delete(projectId);
}

/** 素材清单的文字描述；limit 控制条数，超出的提示用 asset.list 翻 */
export function formatAssets(assets: AgentAsset[], limit: number): string {
  if (!assets.length) {
    return '素材库是空的。图片需要用户在界面上传；你也可以在联网时用 asset.import 按 URL 导入一张。';
  }
  const shown = assets.slice(0, limit);
  const more = assets.length - shown.length;
  const lines = shown.map((a, i) =>
    `${i + 1}. ${a.kind === 'font' ? '🔤' : '🖼'} ${a.name}（id=${a.id}）`
    + `${a.size ? `，${Math.round(a.size / 1024)}KB` : ''}`
    + `${a.url ? '' : '，尚未同步'}`);
  if (more > 0) lines.push(`…还有 ${more} 个，用 asset.list 查看全部`);
  return lines.join('\n');
}

async function describeAssets(ctx: { projectId: string }, limit: number): Promise<string> {
  const assets = await listProjectAssets(ctx);
  const images = assets.filter((a) => a.kind === 'image');
  const fonts = assets.filter((a) => a.kind === 'font');
  if (!assets.length) return `【素材】图 ${images.length} 个 / 字体 ${fonts.length} 个 —— ${formatAssets(assets, limit)}`;
  const body = formatAssets(images.length ? images : assets, limit);
  return `【素材】图 ${images.length} 个 / 字体 ${fonts.length} 个\n${body}`;
}

const norm = (v: unknown): string => String(v ?? '').trim();
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown, d = false): boolean => {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes', 'on', '是', '开'].includes(s)) return true;
  if (['false', '0', 'no', 'off', '否', '关'].includes(s)) return false;
  return d;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);
const strList = (v: unknown): string[] => arr(v).map((x) => norm(x)).filter(Boolean);

/** 写完文档回一段开头预览，模型和用户都能立刻核对写对了没有 */
const textPreview = (s: string, n = 160): string => {
  const t = (s ?? '').trim();
  if (!t) return '（空）';
  return `── 开头预览 ──\n${t.slice(0, n)}${t.length > n ? '…' : ''}`;
};

const clipText = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n…（共 ${s.length} 字，已截断）`;

/**
 * 表格 → Markdown。
 *
 * 表格文档同时维护 `table`（数据本体）与 `content`（这份 Markdown），
 * 前者给工具精确改，后者给人看、也给模型快速扫读。
 */
export function tableToMarkdown(t: TableData, maxRows = 500): string {
  const esc = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = `| ${t.header.map(esc).join(' | ')} |`;
  const sep = `| ${t.header.map(() => '---').join(' | ')} |`;
  const body = t.rows.slice(0, maxRows)
    .map((r) => `| ${t.header.map((_, j) => esc(r[j] ?? '')).join(' | ')} |`);
  const more = t.rows.length > maxRows ? `\n\n…还有 ${t.rows.length - maxRows} 行` : '';
  return [head, sep, ...body].join('\n') + more;
}

/** 列定位：列名 / 名称子串 / 1 起序号 / A、B、C 这样的列标 */
export function colIndex(header: string[], hint: unknown): number {
  const h = norm(hint);
  if (!h) return -1;
  const byName = header.findIndex((x) => x === h);
  if (byName >= 0) return byName;
  const inc = header.findIndex((x) => x !== '' && (x.includes(h) || h.includes(x)));
  if (inc >= 0) return inc;
  const n = Number(h);
  if (Number.isInteger(n) && n >= 1 && n <= header.length) return n - 1;
  if (/^[A-Za-z]{1,2}$/.test(h)) {
    let idx = 0;
    for (const ch of h.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    if (idx >= 1 && idx <= header.length) return idx - 1;
  }
  return -1;
}

/** 每次动作都从库里重新读，保证同一轮里前一条动作的结果对后一条可见 */
async function freshContent(projectId: string): Promise<ProjectContent> {
  const p = await db.projects.get(projectId);
  return (p?.content as ProjectContent) ?? { decks: [], documents: [], settings: {} };
}

function pickDeck(c: ProjectContent, hint?: unknown): Deck | undefined {
  return selectEntity(c.decks ?? [], hint, (d) => d.id, (d) => d.name, true);
}

function pickField(deck: Deck, hint?: unknown): Field | undefined {
  return selectEntity(deck.fields ?? [], hint, (f) => f.id, (f) => f.name);
}

function pickCard(deck: Deck, hint?: unknown) {
  const field = deck.fields?.find((f) => f.id === 'name') ?? deck.fields?.find((f) => f.type === 'text');
  return selectEntity(deck.cards ?? [], hint, (c) => c.id, (c) => field ? norm(c.values?.[field.id]) : '');
}

function pickElement(layout: Layout, hint?: unknown): LayoutElement | undefined {
  return selectEntity(layout.elements ?? [], hint, (e) => e.id, (e) => e.name);
}

function pickDoc(c: ProjectContent, hint?: unknown): ProjectDocument | undefined {
  return selectEntity(c.documents ?? [], hint, (d) => d.id, (d) => d.title, true);
}

type Side = 'front' | 'back';

function sideOf(v: unknown): Side {
  const s = norm(v).toLowerCase();
  if (s.startsWith('back') || s.includes('背') || s.includes('反面') || s === 'b') return 'back';
  return 'front';
}

const deckNames = (c: ProjectContent) => (c.decks ?? []).map((d) => d.name).join('、') || '（暂无牌组）';

const FIELD_TYPES: FieldType[] = ['text', 'number', 'image', 'select', 'color', 'boolean'];
const OPS: CompareOp[] = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty', 'isNotEmpty'];

/** 按字段类型把模型给的原始值转成工程里的存储值 */
function coerce(field: Field | undefined, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return '';
  switch (field?.type) {
    case 'number': return num(raw, 0);
    case 'boolean': return bool(raw, false);
    case 'select': {
      const v = norm(raw);
      if (!field.options?.length) return v;
      return field.options.includes(v) ? v : v; // 不在选项里也写入，由界面提示
    }
    default: return typeof raw === 'object' ? JSON.stringify(raw) : raw;
  }
}

/**
 * 图片字段存的是素材 id，但模型天然会直接写素材名（"火焰纹章.png"）。
 * 这里把名字换成 id；认不出来就原样存，界面会显示空图，错误可见好过静默错。
 */
async function resolveAssetRef(ctx: { projectId: string }, ref: unknown): Promise<string> {
  const raw = typeof ref === 'object' && ref !== null ? JSON.stringify(ref) : norm(ref);
  if (!raw) return '';
  const assets = await listProjectAssets(ctx);
  if (assets.some((a) => a.id === raw)) return raw;
  const hit = selectEntity(assets, raw, (a) => a.id, (a) => a.name);
  return hit ? hit.id : raw;
}

function resolveFieldId(deck: Deck, key: string): string | undefined {
  const f = pickField(deck, key);
  if (f) return f.id;
  return (deck.fields ?? []).some((x) => x.id === key) ? key : undefined;
}

const ELEMENT_PATCH_KEYS = [
  'name', 'x', 'y', 'width', 'height', 'rotation',
  'fill', 'color', 'fillOpacity', 'textOpacity', 'borderOpacity',
  'borderColor', 'borderWidth', 'borderStyle', 'borderRadius',
  'fieldId', 'fontFamily', 'fontWeight', 'fontStyle',
  'text', 'fontSize', 'maxFontSize', 'minFontSize', 'autoFit',
  'lineHeight', 'letterSpacing', 'wrapMode',
  'horizontalAlign', 'verticalAlign', 'imageFit', 'assetId', 'iconId',
  'imageZoom', 'imageFocusX', 'imageFocusY', 'richText', 'groupId',
  'locked', 'hidden', 'countFieldId', 'countMax', 'countSpacing', 'countDirection',
] as const;

/* ------------------------------------------------------------------ */
/* 动作实现                                                             */
/* ------------------------------------------------------------------ */

export function createAgentActions(ctx: AgentCtx): AgentActions {
  /** 包一层：定位牌组 → 在 update 里按 id 重新定位 → 执行 → 返回结果文本 */
  async function withDeck(
    hint: unknown,
    label: string,
    fn: (deck: Deck, c: ProjectContent) => string | void,
  ): Promise<string> {
    const c = await freshContent(ctx.projectId);
    const deck = pickDeck(c, hint);
    if (!deck) return `❌ 找不到牌组「${norm(hint)}」。现有牌组：${deckNames(c)}`;
    const id = deck.id;
    const name = deck.name;
    let out = '';
    await ctx.update((cc) => {
      cc.decks ??= [];
      const d = cc.decks.find((x) => x.id === id);
      if (!d) { out = `❌ 牌组「${name}」已不存在`; return; }
      d.fields ??= [];
      d.cards ??= [];
      out = fn(d, cc) ?? `✅ 已更新牌组「${d.name}」`;
    }, `智能体：${label}`);
    return out;
  }

  async function withLayout(
    deckHint: unknown,
    sideHint: unknown,
    label: string,
    fn: (layout: Layout, deck: Deck, content: ProjectContent) => string | void,
    create = true,
  ): Promise<string> {
    const c = await freshContent(ctx.projectId);
    const deck = pickDeck(c, deckHint);
    if (!deck) return `❌ 找不到牌组「${norm(deckHint)}」。现有牌组：${deckNames(c)}`;
    const side = sideOf(sideHint);
    const deckId = deck.id;
    let out = '';
    await ctx.update((cc) => {
      const d = cc.decks.find((x) => x.id === deckId);
      if (!d) { out = '❌ 牌组已不存在'; return; }
      if (side === 'front') {
        if (!d.frontLayout) {
          if (!create) { out = `❌「${d.name}」还没有正面版式`; return; }
          const o = d.backLayout;
          d.frontLayout = emptyLayout('正面', o?.width ?? 750, o?.height ?? 1050, o?.widthMm ?? 63.5, o?.heightMm ?? 88.9);
        }
        out = fn(d.frontLayout, d, cc) ?? `✅ 已更新「${d.name}」正面版式`;
      } else {
        if (!d.backLayout) {
          if (!create) { out = `❌「${d.name}」还没有背面版式`; return; }
          const f = d.frontLayout;
          d.backLayout = emptyLayout('背面', f?.width ?? 750, f?.height ?? 1050, f?.widthMm ?? 63.5, f?.heightMm ?? 88.9);
        }
        out = fn(d.backLayout, d, cc) ?? `✅ 已更新「${d.name}」背面版式`;
      }
    }, `智能体：${label}`);
    return out;
  }

  async function withElement(
    deckHint: unknown,
    sideHint: unknown,
    elHint: unknown,
    label: string,
    fn: (el: LayoutElement, layout: Layout, deck: Deck) => string | void,
  ): Promise<string> {
    return withLayout(deckHint, sideHint, label, (layout, deck) => {
      const el = pickElement(layout, elHint);
      if (!el) {
        return `❌ 在「${deck.name}」${sideOf(sideHint) === 'front' ? '正面' : '背面'}找不到元素「${norm(elHint)}」。现有元素：${
          (layout.elements ?? []).map((e, i) => `${i + 1}.${e.name}(${e.id})`).join('、') || '（空）'
        }`;
      }
      const eid = el.id;
      const target = (layout.elements ?? []).find((x) => x.id === eid);
      if (!target) return '❌ 元素已不存在';
      return fn(target, layout, deck);
    }, false);
  }

  async function withDoc(
    hint: unknown,
    label: string,
    fn: (doc: ProjectDocument, c: ProjectContent) => string | void,
  ): Promise<string> {
    const c = await freshContent(ctx.projectId);
    const doc = pickDoc(c, hint);
    if (!doc) return `❌ 找不到文档「${norm(hint)}」。现有文档：${(c.documents ?? []).map((d) => d.title).join('、') || '（暂无）'}`;
    const id = doc.id;
    let out = '';
    await ctx.update((cc) => {
      cc.documents ??= [];
      const d = cc.documents.find((x) => x.id === id);
      if (!d) { out = '❌ 文档已不存在'; return; }
      out = fn(d, cc) ?? `✅ 已更新文档「${d.title}」`;
    }, `智能体：${label}`);
    return out;
  }

  const A: AgentActions = {};

  /* ---------------- 项目 ---------------- */

  A['project.overview'] = async () => projectOverview(ctx);

  A['project.rename'] = async (a) => {
    const name = norm(a.name);
    if (!name) return '❌ 缺少 name';
    await ctx.rename(name);
    return `✅ 项目已改名为「${name}」`;
  };

  A['project.setExport'] = async (a) => {
    const patch: Record<string, unknown> = {};
    if (a.dpi !== undefined) patch.dpi = Math.max(72, Math.min(1200, num(a.dpi, 300)));
    if (a.bleedMm !== undefined) patch.bleedMm = Math.max(0, Math.min(20, num(a.bleedMm, 0)));
    if (a.duplex !== undefined) patch.duplex = bool(a.duplex, true);
    if (a.flipOnBack !== undefined) patch.flipOnBack = bool(a.flipOnBack, true);
    if (a.cutLines !== undefined) patch.cutLines = bool(a.cutLines, true);
    if (a.pageSize !== undefined) patch.pageSize = norm(a.pageSize) === 'Letter' ? 'Letter' : 'A4';
    if (!Object.keys(patch).length) return '❌ 没有给出要修改的导出参数';
    await ctx.update((c) => {
      c.settings ??= {};
      c.settings.export = { ...(c.settings.export ?? {}), ...patch } as never;
    }, '智能体：改导出设置');
    return `✅ 导出设置已更新：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join('，')}`;
  };

  A['project.setSetting'] = async (a) => {
    const key = norm(a.key);
    if (!key) return '❌ 缺少 key';
    await ctx.update((c) => {
      c.settings ??= {};
      (c.settings as Record<string, unknown>)[key] = a.value;
    }, '智能体：改项目设置');
    return `✅ 设置 ${key} = ${JSON.stringify(a.value)}`;
  };

  /* ---------------- 牌组 ---------------- */

  A['deck.list'] = async () => {
    const c = await freshContent(ctx.projectId);
    if (!(c.decks ?? []).length) return '当前项目还没有牌组，可用 deck.create 创建。';
    return c.decks.map((d, i) =>
      `${i + 1}. ${d.name}（id=${d.id}）：${d.cards?.length ?? 0} 条卡牌 / ${d.fields?.length ?? 0} 字段` +
      `${d.frontLayout ? ` / 正面 ${(d.frontLayout.elements ?? []).length} 元素` : ''}` +
      `${d.backLayout ? ` / 背面 ${(d.backLayout.elements ?? []).length} 元素` : ''}`).join('\n');
  };

  A['deck.create'] = async (a) => {
    const name = norm(a.name) || `牌组 ${((await freshContent(ctx.projectId)).decks?.length ?? 0) + 1}`;
    const preset = presetByKey(norm(a.preset));
    const w = num(a.width, preset?.width ?? 750);
    const h = num(a.height, preset?.height ?? 1050);
    const wMm = num(a.widthMm, preset?.widthMm ?? 63.5);
    const hMm = num(a.heightMm, preset?.heightMm ?? 88.9);
    const id = uid();
    const withLayout = a.layout === undefined ? true : bool(a.layout, true);
    await ctx.update((c) => {
      c.decks ??= [];
      c.decks.push({
        id,
        name,
        fields: defaultFields(),
        cards: [],
        frontLayout: withLayout ? emptyLayout('正面', w, h, wMm, hMm) : null,
        backLayout: withLayout ? emptyLayout('背面', w, h, wMm, hMm) : null,
        useSharedBack: true,
      });
    }, '智能体：新增牌组');
    return `✅ 已创建牌组「${name}」（id=${id}，${w}×${h}px，默认带 名称/数量 字段）`;
  };

  A['deck.rename'] = (a) => withDeck(a.deck, '重命名牌组', (d) => {
    const old = d.name;
    d.name = norm(a.name) || old;
    return `✅ 牌组「${old}」改名为「${d.name}」`;
  });

  A['deck.delete'] = (a) => withDeck(a.deck, '删除牌组', (d, c) => {
    const n = d.cards?.length ?? 0;
    c.decks = (c.decks ?? []).filter((x) => x.id !== d.id);
    return `✅ 已删除牌组「${d.name}」（含 ${n} 条卡牌）`;
  });

  A['deck.duplicate'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const src = pickDeck(c, a.deck);
    if (!src) return `❌ 找不到牌组「${norm(a.deck)}」。现有牌组：${deckNames(c)}`;
    const copy = JSON.parse(JSON.stringify(src)) as Deck;
    copy.id = uid();
    copy.name = norm(a.name) || `${src.name} 副本`;
    copy.cards = (copy.cards ?? []).map((x) => ({ ...x, id: uid() }));
    if (copy.frontLayout) {
      copy.frontLayout.id = uid();
      copy.frontLayout.elements = (copy.frontLayout.elements ?? []).map((e) => ({ ...e, id: uid() }));
    }
    if (copy.backLayout) {
      copy.backLayout.id = uid();
      copy.backLayout.elements = (copy.backLayout.elements ?? []).map((e) => ({ ...e, id: uid() }));
    }
    await ctx.update((cc) => { cc.decks ??= []; cc.decks.push(copy); }, '智能体：复制牌组');
    return `✅ 已复制为「${copy.name}」（id=${copy.id}）`;
  };

  A['deck.setSize'] = (a) => withDeck(a.deck, '改牌组尺寸', (d) => {
    const preset = presetByKey(norm(a.preset));
    const w = num(a.width, preset?.width ?? d.frontLayout?.width ?? 750);
    const h = num(a.height, preset?.height ?? d.frontLayout?.height ?? 1050);
    const wMm = num(a.widthMm, preset?.widthMm ?? d.frontLayout?.widthMm ?? 63.5);
    const hMm = num(a.heightMm, preset?.heightMm ?? d.frontLayout?.heightMm ?? 88.9);
    for (const l of [d.frontLayout, d.backLayout]) {
      if (!l) continue;
      l.width = w; l.height = h; l.widthMm = wMm; l.heightMm = hMm;
    }
    const p = preset ?? `${w}×${h}`;
    return `✅「${d.name}」尺寸改为 ${typeof p === 'string' ? p : p.name}（${w}×${h}px / ${wMm}×${hMm}mm）`;
  });

  A['deck.setSharedBack'] = (a) => withDeck(a.deck, '改共用牌背', (d) => {
    d.useSharedBack = bool(a.value ?? a.useSharedBack, true);
    return `✅「${d.name}」共用牌背：${d.useSharedBack ? '开' : '关'}`;
  });

  /* ---------------- 字段 ---------------- */

  A['field.list'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」。现有牌组：${deckNames(c)}`;
    if (!(d.fields ?? []).length) return `「${d.name}」还没有字段。`;
    return d.fields.map((f, i) =>
      `${i + 1}. ${f.name}（id=${f.id}，${f.type}${f.options?.length ? `，选项：${f.options.join('/')}` : ''}${f.showInTable ? '，表格显示' : ''}）`).join('\n');
  };

  A['field.add'] = (a) => withDeck(a.deck, '新增字段', (d) => {
    const name = norm(a.name);
    if (!name) return '❌ 缺少 name';
    if ((d.fields ?? []).some((f) => f.name === name)) return `❌ 字段「${name}」已存在`;
    const type = (FIELD_TYPES.includes(norm(a.type) as FieldType) ? norm(a.type) : 'text') as FieldType;
    const id = norm(a.id) || uid().slice(0, 8);
    const f: Field = {
      id,
      name,
      type,
      showInTable: a.showInTable === undefined ? true : bool(a.showInTable, true),
    };
    if (type === 'select') f.options = strList(a.options);
    if (a.default !== undefined) f.defaultValue = coerce(f, a.default);
    d.fields.push(f);
    return `✅ 已在「${d.name}」新增字段「${name}」（id=${id}，${type}${f.options?.length ? `，选项 ${f.options.join('/')}` : ''}）`;
  });

  A['field.rename'] = (a) => withDeck(a.deck, '重命名字段', (d) => {
    const f = pickField(d, a.field);
    if (!f) return `❌ 找不到字段「${norm(a.field)}」。现有：${(d.fields ?? []).map((x) => x.name).join('、')}`;
    const old = f.name;
    f.name = norm(a.name) || old;
    return `✅ 字段「${old}」改名为「${f.name}」`;
  });

  A['field.setType'] = (a) => withDeck(a.deck, '改字段类型', (d) => {
    const f = pickField(d, a.field);
    if (!f) return `❌ 找不到字段「${norm(a.field)}」`;
    const type = norm(a.type) as FieldType;
    if (!FIELD_TYPES.includes(type)) return `❌ 类型必须是 ${FIELD_TYPES.join('/')} 之一`;
    f.type = type;
    if (type === 'select') f.options = strList(a.options);
    return `✅ 字段「${f.name}」类型改为 ${type}${f.options?.length ? `，选项 ${f.options.join('/')}` : ''}`;
  });

  A['field.setOptions'] = (a) => withDeck(a.deck, '改字段选项', (d) => {
    const f = pickField(d, a.field);
    if (!f) return `❌ 找不到字段「${norm(a.field)}」`;
    f.options = strList(a.options);
    return `✅ 字段「${f.name}」选项改为 ${f.options.join('/') || '（空）'}`;
  });

  A['field.delete'] = (a) => withDeck(a.deck, '删除字段', (d) => {
    const f = pickField(d, a.field);
    if (!f) return `❌ 找不到字段「${norm(a.field)}」`;
    d.fields = (d.fields ?? []).filter((x) => x.id !== f.id);
    (d.cards ?? []).forEach((card) => { delete card.values?.[f.id]; });
    return `✅ 已删除字段「${f.name}」，并清除了所有卡牌上的对应值`;
  });

  /* ---------------- 卡牌 ---------------- */

  A['card.list'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」。现有牌组：${deckNames(c)}`;
    const cards = d.cards ?? [];
    if (!cards.length) return `「${d.name}」还没有卡牌。`;
    const limit = Math.max(1, Math.min(200, num(a.limit, 30)));
    const offset = Math.max(0, num(a.offset, 0));
    const slice = cards.slice(offset, offset + limit);
    const head = slice.map((card, i) => {
      const kv = (d.fields ?? [])
        .filter((f) => card.values?.[f.id] !== undefined && card.values?.[f.id] !== '')
        .map((f) => `${f.name}=${JSON.stringify(card.values[f.id])}`)
        .join('，');
      return `${offset + i + 1}. ${kv || '（空）'}  [id=${card.id}]`;
    }).join('\n');
    return `${head}${cards.length > offset + limit ? `\n…还有 ${cards.length - offset - limit} 条，用 offset 继续` : ''}`;
  };

  A['card.find'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const q = norm(a.query ?? a.q).toLowerCase();
    if (!q) return '❌ 缺少 query';
    const hits = (d.cards ?? []).filter((card) =>
      Object.values(card.values ?? {}).some((v) => String(v ?? '').toLowerCase().includes(q)));
    if (!hits.length) return `没有匹配「${q}」的卡牌。`;
    return hits.slice(0, 50).map((card) => {
      const kv = (d.fields ?? []).filter((f) => card.values?.[f.id] !== undefined && card.values?.[f.id] !== '')
        .map((f) => `${f.name}=${JSON.stringify(card.values[f.id])}`).join('，');
      return `· ${kv}  [id=${card.id}]`;
    }).join('\n');
  };

  A['card.add'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」。现有牌组：${deckNames(c)}`;
    const deckId = d.id;
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      deck.cards ??= [];
      const values: Record<string, unknown> = {};
      for (const f of deck.fields ?? []) {
        values[f.id] = f.id === 'count' ? 1 : f.type === 'number' ? 0 : f.type === 'select' ? (f.options?.[0] ?? '') : '';
      }
      if (a.values && typeof a.values === 'object') {
        for (const [k, v] of Object.entries(a.values as Record<string, unknown>)) {
          const fid = resolveFieldId(deck, k);
          if (fid) values[fid] = coerce(deck.fields.find((f) => f.id === fid), v);
        }
      }
      const nm = norm(a.name);
      if (nm) {
        const nf = deck.fields?.find((f) => f.id === 'name') ?? deck.fields?.find((f) => f.type === 'text');
        if (nf) values[nf.id] = nm;
      }
      deck.cards.push({ id: uid(), values });
      out = `✅ 已在「${deck.name}」新增卡牌${nm ? `「${nm}」` : ''}（现共 ${deck.cards.length} 条）`;
    }, '智能体：新增卡牌');
    return out;
  };

  A['card.addMany'] = async (a) => {
    const items = arr(a.items);
    if (!items.length) return '❌ items 为空';
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const deckId = d.id;
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      deck.cards ??= [];
      let n = 0;
      for (const raw of items) {
        const it = (typeof raw === 'string' ? { name: raw } : raw) as Record<string, unknown>;
        const values: Record<string, unknown> = {};
        for (const f of deck.fields ?? []) {
          values[f.id] = f.id === 'count' ? 1 : f.type === 'number' ? 0 : f.type === 'select' ? (f.options?.[0] ?? '') : '';
        }
        for (const [k, v] of Object.entries(it)) {
          if (k === 'name') continue;
          const fid = resolveFieldId(deck, k);
          if (fid) values[fid] = coerce(deck.fields.find((f) => f.id === fid), v);
        }
        const nm = norm(it.name ?? it.名称);
        if (nm) {
          const nf = deck.fields?.find((f) => f.id === 'name') ?? deck.fields?.find((f) => f.type === 'text');
          if (nf) values[nf.id] = nm;
        }
        deck.cards.push({ id: uid(), values });
        n += 1;
      }
      out = `✅ 已在「${deck.name}」批量新增 ${n} 条卡牌（现共 ${deck.cards.length} 条）`;
    }, '智能体：批量新增卡牌');
    return out;
  };

  A['card.update'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const target = pickCard(d, a.card);
    if (!target) return `❌ 找不到卡牌「${norm(a.card)}」，可用 card.list 查看`;
    const deckId = d.id;
    const cardId = target.id;
    const input = (a.values && typeof a.values === 'object' ? a.values : a) as Record<string, unknown>;
    // 图片字段先把「素材名」翻成 id，避免存进去的是个渲染不出来的名字
    const imageValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      if (['deck', 'card', 'values'].includes(k)) continue;
      const fid = resolveFieldId(d, k);
      if (!fid) continue;
      if (d.fields.find((f) => f.id === fid)?.type === 'image') {
        imageValues[fid] = await resolveAssetRef(ctx, v);
      }
    }
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      const card = deck.cards.find((x) => x.id === cardId);
      if (!card) { out = '❌ 卡牌已不存在'; return; }
      const changed: string[] = [];
      for (const [k, v] of Object.entries(input)) {
        if (['deck', 'card', 'values'].includes(k)) continue;
        const fid = resolveFieldId(deck, k);
        if (!fid) { changed.push(`${k}(未识别)`); continue; }
        const f = deck.fields.find((x) => x.id === fid);
        card.values[fid] = imageValues[fid] ?? coerce(f, v);
        changed.push(`${f?.name ?? k}=${JSON.stringify(card.values[fid])}`);
      }
      out = changed.length ? `✅ 已更新卡牌：${changed.join('，')}` : '⚠️ 没有可识别的字段';
    }, '智能体：改卡牌');
    return out;
  };

  A['card.set'] = (a) => A['card.update']({ deck: a.deck, card: a.card, values: { [norm(a.field)]: a.value } });

  A['card.delete'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const target = pickCard(d, a.card);
    if (!target) return `❌ 找不到卡牌「${norm(a.card)}」`;
    const deckId = d.id;
    const cardId = target.id;
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      const before = deck.cards.length;
      deck.cards = deck.cards.filter((x) => x.id !== cardId);
      out = `✅ 已删除卡牌（${before} → ${deck.cards.length} 条）`;
    }, '智能体：删除卡牌');
    return out;
  };

  A['card.duplicate'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const target = pickCard(d, a.card);
    if (!target) return `❌ 找不到卡牌「${norm(a.card)}」`;
    const deckId = d.id;
    const n = Math.max(1, Math.min(50, num(a.n, 1)));
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      const card = deck.cards.find((x) => x.id === target.id);
      if (!card) { out = '❌ 卡牌已不存在'; return; }
      for (let i = 0; i < n; i += 1) deck.cards.push({ id: uid(), values: JSON.parse(JSON.stringify(card.values)) });
      out = `✅ 已复制 ${n} 份（现共 ${deck.cards.length} 条）`;
    }, '智能体：复制卡牌');
    return out;
  };

  /** 批量：整个牌组某个字段统一赋值（常用于「全部数量改成 2」） */
  A['card.batchSet'] = async (a) => {
    const fieldHint = norm(a.field ?? a.name);
    if (!fieldHint) return '❌ 缺少 field';
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    if (!pickField(d, fieldHint)) return `❌ 找不到字段「${fieldHint}」。现有：${(d.fields ?? []).map((f) => f.name).join('、')}`;
    const deckId = d.id;
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      const f = pickField(deck, fieldHint);
      if (!f) { out = '❌ 字段已不存在'; return; }
      const v = coerce(f, a.value);
      (deck.cards ?? []).forEach((card) => { card.values[f.id] = v; });
      out = `✅「${deck.name}」全部 ${deck.cards.length} 条卡牌的「${f.name}」设为 ${JSON.stringify(v)}`;
    }, '智能体：批量改字段');
    return out;
  };

  /** 批量：按卡片逐条赋值 items=[{card, values}] */
  A['card.batchFill'] = async (a) => {
    const items = arr(a.items);
    if (!items.length) return '❌ items 为空';
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const pairs: { cardId: string; values: Record<string, unknown> }[] = [];
    const errs: string[] = [];
    for (const raw of items) {
      const it = raw as Record<string, unknown>;
      const t = pickCard(d, it.card ?? it.id ?? it.name);
      if (!t) { errs.push(`找不到卡牌 ${norm(it.card ?? it.id ?? it.name)}`); continue; }
      pairs.push({ cardId: t.id, values: (it.values ?? it) as Record<string, unknown> });
    }
    const deckId = d.id;
    let out = '';
    await ctx.update((cc) => {
      const deck = cc.decks.find((x) => x.id === deckId);
      if (!deck) { out = '❌ 牌组已不存在'; return; }
      let n = 0;
      for (const p of pairs) {
        const card = deck.cards.find((x) => x.id === p.cardId);
        if (!card) continue;
        for (const [k, v] of Object.entries(p.values)) {
          if (k === 'card' || k === 'id') continue;
          const fid = resolveFieldId(deck, k);
          if (fid) card.values[fid] = coerce(deck.fields.find((f) => f.id === fid), v);
        }
        n += 1;
      }
      out = `✅ 已更新 ${n} 条卡牌${errs.length ? `；${errs.length} 条失败：${errs.slice(0, 3).join('；')}` : ''}`;
    }, '智能体：批量改卡牌');
    return out;
  };

  /* ---------------- 版式与元素 ---------------- */

  A['element.list'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const d = pickDeck(c, a.deck);
    if (!d) return `❌ 找不到牌组「${norm(a.deck)}」`;
    const l = sideOf(a.side) === 'front' ? d.frontLayout : d.backLayout;
    if (!l) return `「${d.name}」还没有${sideOf(a.side) === 'front' ? '正面' : '背面'}版式。`;
    if (!(l.elements ?? []).length) return `「${d.name}」${l.name}版式还没有元素。`;
    return l.elements.map((e, i) => {
      const extra = [
        e.fieldId ? `绑定字段=${e.fieldId}` : e.text ? `文本="${String(e.text).slice(0, 20)}"` : '',
        e.displayCondition ? '有条件' : '',
        e.countFieldId ? `数量展开=${e.countFieldId}` : '',
      ].filter(Boolean).join('，');
      return `${i + 1}. [${e.id}] ${e.name}（${e.kind}）@${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.width)}×${Math.round(e.height)}${extra ? ` — ${extra}` : ''}`;
    }).join('\n');
  };

  A['element.add'] = (a) => withLayout(a.deck, a.side, '新增元素', (layout, deck, current) => {
    const kind = norm(a.kind) || 'text';
    if (!['text', 'image', 'icon', 'rectangle', 'ellipse', 'line'].includes(kind)) {
      return `❌ kind 必须是 text/image/icon/rectangle/ellipse/line 之一`;
    }
    const name = norm(a.name) || `${kind === 'text' ? '文本' : kind === 'rectangle' ? '矩形' : kind === 'ellipse' ? '圆形' : kind === 'icon' ? '图标' : kind === 'image' ? '图片' : '线条'} ${(layout.elements?.length ?? 0) + 1}`;
    const el: LayoutElement = {
      id: norm(a.id) || uid().slice(0, 8),
      kind: kind as LayoutElement['kind'],
      name,
      x: num(a.x, 60),
      y: num(a.y, 60),
      width: num(a.width, kind === 'text' ? 400 : 200),
      height: num(a.height, kind === 'text' ? 80 : 200),
      rotation: num(a.rotation, 0),
      fill: norm(a.fill) || (kind === 'text' || kind === 'line' ? 'transparent' : '#ffffff'),
      color: norm(a.color) || '#18181b',
    };
    if (kind === 'rectangle' || kind === 'ellipse') {
      el.borderColor = norm(a.borderColor) || '#e5e7eb';
      el.borderWidth = num(a.borderWidth, 1);
      el.borderRadius = num(a.borderRadius, kind === 'ellipse' ? Math.min(el.width, el.height) / 2 : 8);
    }
    if (kind === 'text' || kind === 'icon') {
      el.fontSize = num(a.fontSize, 32);
      el.autoFit = a.autoFit === undefined ? true : bool(a.autoFit, true);
      el.horizontalAlign = (norm(a.horizontalAlign) || 'center') as LayoutElement['horizontalAlign'];
      el.verticalAlign = (norm(a.verticalAlign) || 'middle') as LayoutElement['verticalAlign'];
      if (a.fontWeight) el.fontWeight = norm(a.fontWeight) === 'bold' ? 'bold' : 'normal';
      el.fontFamily = norm(a.fontFamily || current.settings?.defaultFont || 'sans');
      if (a.lineHeight) el.lineHeight = num(a.lineHeight, 1.3);
      if (a.wrapMode) el.wrapMode = norm(a.wrapMode) as LayoutElement['wrapMode'];
    }
    if (norm(a.text)) el.text = norm(a.text);
    if (a.fieldId !== undefined) {
      const fid = norm(a.fieldId) ? resolveFieldId(deck, norm(a.fieldId)) : undefined;
      if (norm(a.fieldId) && fid) el.fieldId = fid;
      else if (norm(a.fieldId)) return `❌ 找不到字段「${norm(a.fieldId)}」。现有：${(deck.fields ?? []).map((f) => f.name).join('、')}`;
    }
    if (a.assetId) el.assetId = norm(a.assetId);
    if (a.iconId) el.iconId = norm(a.iconId);
    layout.elements ??= [];
    layout.elements.push(el);
    return `✅ 已在「${deck.name}」${layout.name}新增元素「${name}」（id=${el.id}，${el.kind}）`;
  });

  A['element.update'] = (a) => withElement(a.deck, a.side, a.element, '改元素', (el, _layout, deck) => {
    const src = (a.patch && typeof a.patch === 'object' ? a.patch : a) as Record<string, unknown>;
    const keys = Object.keys(src).filter((k) => !['deck', 'side', 'element', 'tool', 'patch'].includes(k));
    const bad = keys.filter((k) => !(ELEMENT_PATCH_KEYS as readonly string[]).includes(k));
    const changed: string[] = [];
    for (const k of keys) {
      if (bad.includes(k)) continue;
      if (k === 'fieldId' && norm(src[k])) {
        const fid = resolveFieldId(deck, norm(src[k]));
        if (!fid) return `❌ 找不到字段「${norm(src[k])}」。现有：${(deck.fields ?? []).map((f) => f.name).join('、')}`;
        el.fieldId = fid;
      } else {
        (el as unknown as Record<string, unknown>)[k] = src[k];
      }
      changed.push(`${k}=${JSON.stringify(src[k])}`);
    }
    if (!changed.length) return `⚠️ 没有可修改的属性。允许：${ELEMENT_PATCH_KEYS.join('/')}`;
    return `✅ 元素「${el.name}」已改：${changed.join('，')}${bad.length ? `（忽略未知属性 ${bad.join('/')}）` : ''}`;
  });

  A['element.move'] = (a) => withElement(a.deck, a.side, a.element, '移动元素', (el) => {
    if (a.x !== undefined) el.x = num(a.x, el.x);
    if (a.y !== undefined) el.y = num(a.y, el.y);
    return `✅「${el.name}」移到 (${Math.round(el.x)}, ${Math.round(el.y)})`;
  });

  A['element.resize'] = (a) => withElement(a.deck, a.side, a.element, '缩放元素', (el) => {
    if (a.width !== undefined) el.width = Math.max(1, num(a.width, el.width));
    if (a.height !== undefined) el.height = Math.max(1, num(a.height, el.height));
    return `✅「${el.name}」尺寸改为 ${Math.round(el.width)}×${Math.round(el.height)}`;
  });

  A['element.style'] = (a) => withElement(a.deck, a.side, a.element, '改元素样式', (el) => {
    const changed: string[] = [];
    const set = (k: keyof LayoutElement, v: unknown) => {
      if (v === undefined) return;
      (el as unknown as Record<string, unknown>)[k as string] = v;
      changed.push(`${String(k)}=${JSON.stringify(v)}`);
    };
    set('fill', a.fill === undefined ? undefined : norm(a.fill));
    set('color', a.color === undefined ? undefined : norm(a.color));
    set('borderColor', a.borderColor === undefined ? undefined : norm(a.borderColor));
    set('borderWidth', a.borderWidth === undefined ? undefined : num(a.borderWidth, 1));
    set('borderRadius', a.borderRadius === undefined ? undefined : num(a.borderRadius, 0));
    set('borderStyle', a.borderStyle === undefined ? undefined : norm(a.borderStyle));
    set('fontSize', a.fontSize === undefined ? undefined : num(a.fontSize, 32));
    set('fontWeight', a.fontWeight === undefined ? undefined : (norm(a.fontWeight) === 'bold' ? 'bold' : 'normal'));
    set('fontFamily', a.fontFamily === undefined ? undefined : norm(a.fontFamily));
    set('horizontalAlign', a.horizontalAlign === undefined ? undefined : norm(a.horizontalAlign));
    set('verticalAlign', a.verticalAlign === undefined ? undefined : norm(a.verticalAlign));
    set('fillOpacity', a.opacity === undefined ? undefined : num(a.opacity, 1));
    if (!changed.length) return '⚠️ 没有给出样式参数';
    return `✅ 元素「${el.name}」样式：${changed.join('，')}`;
  });

  A['element.rename'] = (a) => withElement(a.deck, a.side, a.element, '重命名元素', (el) => {
    const old = el.name;
    el.name = norm(a.name) || old;
    return `✅ 元素「${old}」改名为「${el.name}」`;
  });

  A['element.bind'] = (a) => withElement(a.deck, a.side, a.element, '绑定字段', (el, _l, deck) => {
    if (!norm(a.fieldId)) { delete el.fieldId; return `✅ 已解除「${el.name}」的字段绑定`; }
    const fid = resolveFieldId(deck, norm(a.fieldId));
    if (!fid) return `❌ 找不到字段「${norm(a.fieldId)}」。现有：${(deck.fields ?? []).map((f) => f.name).join('、')}`;
    el.fieldId = fid;
    return `✅「${el.name}」已绑定字段「${deck.fields.find((f) => f.id === fid)?.name}」（${fid}）`;
  });

  A['element.condition'] = (a) => withElement(a.deck, a.side, a.element, '设显示条件', (el, _l, deck) => {
    if (bool(a.clear, false)) { delete el.displayCondition; return `✅ 已清除「${el.name}」的显示条件`; }
    const build = (raw: unknown): AnyCondition | string => {
      const r = raw as Record<string, unknown>;
      const fid = resolveFieldId(deck, norm(r.field ?? r.fieldId ?? r.f));
      if (!fid) return `找不到字段「${norm(r.field ?? r.fieldId ?? r.f)}」`;
      const op = norm(r.op ?? r.operator ?? 'equals') as CompareOp;
      if (!OPS.includes(op)) return `运算符必须是 ${OPS.join('/')} 之一`;
      return { type: 'comparison', fieldId: fid, operator: op, value: r.value };
    };
    const list = arr(a.conditions);
    if (list.length) {
      const conds: AnyCondition[] = [];
      for (const raw of list) {
        const built = build(raw);
        if (typeof built === 'string') return `❌ ${built}`;
        conds.push(built);
      }
      el.displayCondition = conds.length === 1 && !bool(a.group, false)
        ? conds[0]
        : { type: 'group', operator: norm(a.mode) === 'any' ? 'any' : 'all', conditions: conds };
    }
    const one = build(a);
    if (typeof one === 'string') return `❌ ${one}`;
    el.displayCondition = one as AnyCondition;
    return `✅「${el.name}」显示条件已设置`;
  });

  A['element.countExpand'] = (a) => withElement(a.deck, a.side, a.element, '设数量展开', (el, _l, deck) => {
    if (bool(a.clear, false)) {
      delete el.countFieldId; delete el.countMax; delete el.countSpacing; delete el.countDirection;
      return `✅ 已清除「${el.name}」的数量展开`;
    }
    const fid = resolveFieldId(deck, norm(a.fieldId ?? a.field ?? 'count'));
    if (!fid) return `❌ 找不到字段「${norm(a.fieldId ?? a.field ?? 'count')}」。现有：${(deck.fields ?? []).map((f) => f.name).join('、')}`;
    el.countFieldId = fid;
    if (a.max !== undefined) el.countMax = Math.max(1, num(a.max, 10));
    if (a.spacing !== undefined) el.countSpacing = num(a.spacing, 8);
    if (a.direction !== undefined) el.countDirection = norm(a.direction) === 'vertical' ? 'vertical' : 'horizontal';
    return `✅「${el.name}」按「${deck.fields.find((f) => f.id === fid)?.name}」数量展开（上限 ${el.countMax ?? 10}，${el.countDirection ?? 'horizontal'}）`;
  });

  A['element.delete'] = (a) => withLayout(a.deck, a.side, '删除元素', (layout) => {
    const el = pickElement(layout, a.element);
    if (!el) return `❌ 找不到元素「${norm(a.element)}」。现有：${(layout.elements ?? []).map((e) => `${e.name}(${e.id})`).join('、') || '（空）'}`;
    layout.elements = (layout.elements ?? []).filter((x) => x.id !== el.id);
    return `✅ 已删除元素「${el.name}」`;
  }, false);

  A['layout.setBackground'] = (a) => withLayout(a.deck, a.side, '改版式背景', (layout) => {
    if (a.assetId !== undefined) layout.backgroundAssetId = norm(a.assetId) || null;
    if (a.color !== undefined) layout.backgroundColor = norm(a.color);
    return `✅「${layout.name}」背景改为 ${norm(a.color) || (layout.backgroundAssetId ? `素材 ${layout.backgroundAssetId}` : '默认')}`;
  });

  A['layout.setBorder'] = (a) => withLayout(a.deck, a.side, '改版式边框', (layout) => {
    if (a.color !== undefined) layout.borderColor = norm(a.color);
    if (a.width !== undefined) layout.borderWidth = num(a.width, 1);
    if (a.radius !== undefined) layout.borderRadius = num(a.radius, 0);
    return `✅「${layout.name}」边框：色 ${layout.borderColor} / 宽 ${layout.borderWidth} / 圆角 ${layout.borderRadius}`;
  });

  A['layout.setSize'] = (a) => withLayout(a.deck, a.side, '改版式尺寸', (layout) => {
    const preset = presetByKey(norm(a.preset));
    const w = num(a.width, preset?.width ?? layout.width);
    const h = num(a.height, preset?.height ?? layout.height);
    layout.width = w; layout.height = h;
    if (preset) { layout.widthMm = preset.widthMm; layout.heightMm = preset.heightMm; }
    if (a.widthMm !== undefined) layout.widthMm = num(a.widthMm, layout.widthMm ?? 63.5);
    if (a.heightMm !== undefined) layout.heightMm = num(a.heightMm, layout.heightMm ?? 88.9);
    return `✅「${layout.name}」尺寸改为 ${w}×${h}px（${layout.widthMm}×${layout.heightMm}mm）`;
  });

  A['layout.clear'] = (a) => withLayout(a.deck, a.side, '清空版式', (layout) => {
    const n = layout.elements?.length ?? 0;
    layout.elements = [];
    return `✅ 已清空「${layout.name}」的 ${n} 个元素`;
  });

  /* ---------------- 文档 ---------------- */

  A['doc.list'] = async () => {
    const c = await freshContent(ctx.projectId);
    if (!(c.documents ?? []).length) return '还没有文档。';
    return c.documents.map((d, i) => {
      const size = d.kind === 'table'
        ? `表格 ${d.table?.header?.length ?? 0} 列 × ${d.table?.rows?.length ?? 0} 行`
        : `${(d.content ?? '').length} 字`;
      return `${i + 1}. ${d.kind === 'table' ? '📊' : '📝'} ${d.title}（id=${d.id}，${size}）`;
    }).join('\n');
  };

  A['doc.create'] = async (a) => {
    const title = norm(a.title) || '未命名文档';
    const content = String(a.content ?? '');
    if (!content.trim()) return '❌ content 是空的，没有要写的内容';
    let out = '';
    await ctx.update((c) => {
      c.documents ??= [];
      // 重名自动加后缀，避免同一轮里生成两篇同名文档
      let t = title;
      if (c.documents.some((x) => x.title === t)) {
        let n = 2;
        while (c.documents.some((x) => x.title === `${title}-${n}`)) n += 1;
        t = `${title}-${n}`;
      }
      const now = new Date().toISOString();
      const d: ProjectDocument = {
        id: uid(), title: t, kind: 'markdown', content, createdAt: now, updatedAt: now,
      };
      c.documents.push(d);
      out = `✅ 已创建文档「${t}」（id=${d.id}，${content.length} 字）\n${textPreview(content)}`;
    }, '智能体：新增文档');
    return out;
  };

  A['doc.update'] = (a) => withDoc(a.doc, '改文档', (d) => {
    if (d.kind === 'table') {
      return '❌「' + d.title + '」是表格文档，正文由表格数据自动生成，改 content 界面上看不到。'
        + '要改单元格用 doc.tableSet；要写自由文本请先用 doc.create 新建一篇普通文档。';
    }
    if (a.title !== undefined) d.title = norm(a.title);
    if (a.content !== undefined) {
      const next = String(a.content);
      if (!next.trim() && a.title === undefined) return '❌ content 为空且没给 title，不知道要改什么';
      d.content = next;
    } else if (a.title === undefined) {
      return '❌ 既没给 content 也没给 title，没有要改的内容';
    }
    d.updatedAt = new Date().toISOString();
    return `✅ 文档「${d.title}」已更新（${(d.content ?? '').length} 字）\n${textPreview(d.content ?? '')}`;
  });

  A['doc.append'] = (a) => withDoc(a.doc, '追加文档', (d) => {
    const add = String(a.content ?? '');
    if (!add.trim()) return '❌ content 是空的，没有要追加的内容';
    if (d.kind === 'table') {
      return '❌「' + d.title + '」是表格文档，追加正文界面上看不到。要加数据行用 doc.tableAddRow。';
    }
    d.content = `${d.content ?? ''}${d.content && !d.content.endsWith('\n') ? '\n' : ''}${add}`;
    d.updatedAt = new Date().toISOString();
    return `✅ 已向「${d.title}」追加 ${add.length} 字（共 ${d.content.length} 字）\n${textPreview(add)}`;
  });

  A['doc.delete'] = (a) => withDoc(a.doc, '删除文档', (d, c) => {
    c.documents = (c.documents ?? []).filter((x) => x.id !== d.id);
    return `✅ 已删除文档「${d.title}」`;
  });

  /* ---------------- 素材 ---------------- */

  const availableFonts = async () => {
    const custom = (await listProjectAssets(ctx)).filter((a) => a.kind === 'font');
    return [...FONTS.map((f) => ({ id: f.key, name: f.name })), ...custom.map((f) => ({ id: fontKey(f.id), name: f.name }))];
  };
  A['font.list'] = async () => (await availableFonts()).map((f) => `${f.name} [key=${f.id}]`).join('\n');
  A['font.set'] = async (a) => {
    if (!norm(a.font)) return '❌ 缺少 font，请先 font.list';
    const font = selectEntity(await availableFonts(), a.font, (f) => f.id, (f) => f.name);
    if (!font) return '❌ 字体不存在，请先 font.list；自定义字体请用户在字体库上传';
    const current = await freshContent(ctx.projectId);
    const deck = a.deck ? pickDeck(current, a.deck) : undefined;
    if (a.deck && !deck) return '❌ 牌组不存在';
    if (a.element && !deck) return '❌ 指定 element 时必须提供 deck';
    const side = norm(a.side) || 'both';
    if (!['front', 'back', 'both'].includes(side)) return '❌ side 必须是 front/back/both';
    const targets: { deck: string; side: 'frontLayout' | 'backLayout'; id: string }[] = [];
    for (const d of deck ? [deck] : current.decks) for (const key of ['frontLayout', 'backLayout'] as const) {
      if (side !== 'both' && key !== `${side}Layout`) continue;
      const layout = d[key]; if (!layout) continue;
      const chosen = a.element ? pickElement(layout, a.element) : undefined;
      for (const e of layout.elements) if (e.kind === 'text' && (!a.element || e.id === chosen?.id)) targets.push({ deck: d.id, side: key, id: e.id });
    }
    if (a.element && targets.length !== 1) return '❌ 元素定位不唯一或不是文字，请指定正面/背面和精确元素 id';
    await ctx.update((c) => {
      for (const t of targets) { const e = c.decks.find((d) => d.id === t.deck)?.[t.side]?.elements.find((e) => e.id === t.id); if (e) e.fontFamily = font.id; }
      if (a.setDefault === true) (c.settings ??= {}).defaultFont = font.id;
    }, '智能体：设定字体');
    return `✅ 已将 ${targets.length} 个文字元素设为「${font.name}」${a.setDefault === true ? '，同时更新默认字体' : ''}`;
  };

  const pickAsset = async (hint: unknown) => {
    const rows = await listProjectAssets(ctx);
    const h = norm(hint);
    // 直接给 id 时优先精确匹配，避免同名素材选错
    const exact = rows.find((x) => x.id === h);
    const hit = exact ?? selectEntity(rows, h, (x) => x.id, (x) => x.name);
    if (!hit) {
      return { err: `❌ 找不到素材「${h}」。现有素材：${rows.slice(0, 20).map((x) => `${x.name}(${x.id})`).join('、') || '（库里没有素材）'}` } as const;
    }
    return { hit } as const;
  };

  A['asset.list'] = async (a) => {
    const rows = await listProjectAssets(ctx, { force: true });
    const kind = norm(a.kind);
    const picked = kind === 'image' || kind === 'font' ? rows.filter((x) => x.kind === kind) : rows;
    if (!picked.length) {
      return kind
        ? `库里没有${kind === 'image' ? '图片' : '字体'}素材。图片可以请用户在素材库上传，或联网时用 asset.import 按 URL 导入。`
        : formatAssets(rows, 8);
    }
    const limit = Math.max(1, Math.min(200, num(a.limit, 40)));
    return formatAssets(picked, limit);
  };

  A['asset.rename'] = async (a) => {
    const got = await pickAsset(a.asset);
    if (got.err) return got.err;
    const name = norm(a.name);
    if (!name) return '❌ 缺少 name';
    try { await api.renameAsset(got.hit.id, name); }
    catch { await db.assets.update(got.hit.id, { name }); }
    invalidateAssets(ctx.projectId);
    return `✅ 素材「${got.hit.name}」改名为「${name}」`;
  };

  A['asset.delete'] = async (a) => {
    const got = await pickAsset(a.asset);
    if (got.err) return got.err;
    try { await api.deleteAsset(got.hit.id); }
    catch { await db.assets.delete(got.hit.id); }
    invalidateAssets(ctx.projectId);
    return `✅ 已删除素材「${got.hit.name}」`;
  };

  /**
   * 后端代抓外链图片入库。
   * 智能体没有浏览器环境，前端直连外链会被 CORS 拦掉，所以下载这一步必须在后端做。
   */
  A['asset.import'] = async (a) => {
    const url = norm(a.url);
    if (!url) return '❌ 缺少 url';
    if (!/^https?:\/\//i.test(url)) return '❌ url 必须是 http(s) 链接';
    const local = await db.projects.get(ctx.projectId);
    let result: { id: string; name: string };
    try {
      const r = await api.importAssetUrl({
        url,
        project_id: local?.remoteId ?? ctx.projectId,
        ...(norm(a.name) ? { name: norm(a.name) } : {}),
      });
      result = { id: r.asset.id, name: r.asset.name };
    } catch (e) {
      return `❌ 导入失败：${(e as Error).message}（若后端未启动请开启；外链站点也可能拒绝抓取）`;
    }
    invalidateAssets(ctx.projectId);
    return `✅ 已导入图片「${result.name}」到素材库（id=${result.id}）\n`
      + `现在可以：element.update {element:<插图框>, patch:{assetId:"${result.id}"}}，`
      + '或 card.set 给 image 字段赋这个值。';
  };

  /** 把素材放进版式：指定元素就替换它的图，否则新建一个插图框 */
  A['asset.use'] = async (a) => {
    const id = norm(a.asset) || norm(a.assetId);
    if (!id) return '❌ 缺少 asset（素材 id 或名称），先用 asset.list 查';
    // 先校验素材真的存在——凭空编 id 是最常见的失败，早失败比在画布上留个空框好
    const got = await pickAsset(id);
    if (got.err) return got.err;
    return withLayout(a.deck, a.side, '使用素材', (layout, deck) => {
    const existing = norm(a.element) ? pickElement(layout, a.element) : undefined;
    if (norm(a.element) && !existing) return `❌ 找不到元素「${norm(a.element)}」`;
    if (existing) {
      if (existing.kind !== 'image') return `❌ 元素「${existing.name}」是 ${existing.kind}，不是图片元素`;
      existing.assetId = got.hit.id;
      if (a.imageFit) existing.imageFit = norm(a.imageFit) === 'contain' ? 'contain' : 'cover';
      return `✅ 已把「${got.hit.name}」放进插图框「${existing.name}」（${existing.width}×${existing.height}）`;
    }
    const el: LayoutElement = {
      id: uid(), kind: 'image', name: norm(a.name) || got.hit.name || '插图框',
      x: num(a.x, 60), y: num(a.y, 60), width: num(a.width, 240), height: num(a.height, 240),
      rotation: 0, fill: '#e5e7eb', color: '#111827',
      imageFit: norm(a.imageFit) === 'contain' ? 'contain' : 'cover',
      assetId: got.hit.id,
    };
    layout.elements ??= [];
    layout.elements.push(el);
    return `✅ 已在「${deck.name}」新建插图框「${el.name}」并放入「${got.hit.name}」`
      + `（id=${el.id}，${Math.round(el.width)}×${Math.round(el.height)} @${Math.round(el.x)},${Math.round(el.y)}）`;
    });
  };

  /* ---------------- 结构化表格文档 ---------------- */

  /** 定位一篇表格文档 */
  async function withTable(
    hint: unknown,
    label: string,
    fn: (t: TableData, doc: ProjectDocument) => string | void,
    readOnly = false,
  ): Promise<string> {
    const c = await freshContent(ctx.projectId);
    const doc = pickDoc(c, hint);
    if (!doc) return `❌ 找不到文档「${norm(hint)}」。现有文档：${(c.documents ?? []).map((d) => d.title).join('、') || '（暂无）'}`;
    if (doc.kind !== 'table' || !doc.table) {
      return `❌「${doc.title}」不是表格文档（kind=${doc.kind ?? 'markdown'}）。可用 doc.createTable 新建，或先让用户在文档页上传 xlsx/csv。`;
    }
    if (readOnly) return fn(doc.table, doc) ?? '';
    const id = doc.id;
    let out = '';
    await ctx.update((cc) => {
      const d = (cc.documents ?? []).find((x) => x.id === id);
      if (!d?.table) { out = '❌ 表格已不存在'; return; }
      out = fn(d.table, d) ?? `✅ 已更新表格「${d.title}」`;
      d.content = tableToMarkdown(d.table);
      d.updatedAt = new Date().toISOString();
    }, `智能体：${label}`);
    return out;
  }

  A['doc.createTable'] = async (a) => {
    const title = norm(a.title) || '新表格';
    const header = strList(a.header);
    if (!header.length) return '❌ 缺少 header（列名数组）';
    const rows = arr(a.rows).map((r) => (Array.isArray(r) ? r.map((x) => norm(x)) : []));
    let out = '';
    await ctx.update((c) => {
      c.documents ??= [];
      const now = new Date().toISOString();
      const table: TableData = { header, rows };
      const d: ProjectDocument = {
        id: uid(), title, kind: 'table', table,
        content: tableToMarkdown(table), createdAt: now, updatedAt: now,
      };
      c.documents.push(d);
      out = `✅ 已创建表格文档「${title}」（id=${d.id}，${header.length} 列 / ${rows.length} 行）`;
    }, '智能体：新建表格');
    return out;
  };

  A['doc.read'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const doc = pickDoc(c, a.doc);
    if (!doc) return `❌ 找不到文档「${norm(a.doc)}」。现有文档：${(c.documents ?? []).map((d) => d.title).join('、') || '（暂无）'}`;
    const body = doc.kind === 'table' && doc.table ? tableToMarkdown(doc.table, doc.table.rows.length) : (doc.content ?? '');
    return `【${doc.title}】（${doc.kind ?? 'markdown'}，${body.length} 字）\n${textPage(body, a.offset, a.limit)}`;
  };

  A['doc.tableRead'] = async (a) => withTable(a.doc, '读表格', (t, d) => {
    const limit = Math.max(1, Math.min(300, Math.floor(num(a.limit, 60))));
    const offset = Math.max(0, Math.floor(num(a.offset, 0)));
    const rows: string[][] = [];
    for (const row of t.rows.slice(offset, offset + limit)) {
      const candidate = tableToMarkdown({ header: t.header, rows: [...rows, row] });
      if (candidate.length > 3000) break;
      rows.push(row);
    }
    if (!rows.length && offset < t.rows.length) return `【${d.title}】单行过长，请用 doc.read {doc:"${d.id}",offset:0,limit:2500} 按字符读取完整内容。`;
    const next = offset + rows.length;
    return `【${d.title}】${t.rows.length} 行 × ${t.header.length} 列；nextOffset=${next < t.rows.length ? next : 'null'}\n${tableToMarkdown({ header: t.header, rows })}`;
  }, true);

  A['doc.tableFind'] = async (a) => withTable(a.doc, '搜表格', (t, d) => {
    const q = norm(a.query ?? a.q).toLowerCase();
    if (!q) return '❌ 缺少 query';
    const colName = norm(a.column);
    const ci = colName ? colIndex(t.header, colName) : -1;
    if (colName && ci < 0) return `❌ 找不到列「${colName}」。列名：${t.header.join('、')}`;
    const hits: string[] = [];
    t.rows.forEach((r, i) => {
      const hay = ci >= 0 ? String(r[ci] ?? '') : r.join(' ');
      if (hay.toLowerCase().includes(q)) hits.push(`行${i + 1}: ${r.map((v, j) => `${t.header[j]}=${v}`).join('，')}`);
    });
    if (!hits.length) return `「${d.title}」里没有匹配「${q}」的行。`;
    return `命中 ${hits.length} 行：\n${hits.slice(0, 40).join('\n')}`;
  }, true);

  A['doc.tableStats'] = async (a) => withTable(a.doc, '表格概况', (t, d) => {
    const emptyByCol = t.header.map((h, j) => t.rows.filter((r) => !norm(r[j])).length);
    return [
      `【${d.title}】${t.rows.length} 行 × ${t.header.length} 列${t.sheet ? `（sheet=${t.sheet}）` : ''}`,
      `列：${t.header.map((h, j) => `${j + 1}.${h || '(空列名)'}`).join('，')}`,
      `各列空值数：${t.header.map((h, j) => `${h || j + 1}=${emptyByCol[j]}`).join('，')}`,
      t.rows.length ? `首行示例：${t.rows[0].map((v, j) => `${t.header[j]}=${v}`).join('，')}` : '（无数据行）',
    ].join('\n');
  }, true);

  A['doc.tableSet'] = async (a) => withTable(a.doc, '改单元格', (t) => {
    const ri = Math.round(num(a.row, 0)) - 1;
    if (!(ri >= 0 && ri < t.rows.length)) return `❌ row 超出范围（1..${t.rows.length}）`;
    const ci = colIndex(t.header, a.column);
    if (ci < 0) return `❌ 找不到列「${norm(a.column)}」。列名：${t.header.join('、')}`;
    const old = t.rows[ri][ci] ?? '';
    t.rows[ri][ci] = String(a.value ?? '');
    return `✅ 第 ${ri + 1} 行「${t.header[ci]}」：${JSON.stringify(old)} → ${JSON.stringify(t.rows[ri][ci])}`;
  });

  A['doc.tableAddRow'] = async (a) => withTable(a.doc, '加一行', (t) => {
    let vals: unknown[] = [];
    if (Array.isArray(a.values)) vals = a.values;
    else if (a.values && typeof a.values === 'object') {
      vals = t.header.map((h) => (a.values as Record<string, unknown>)[h] ?? '');
    }
    const row = t.header.map((_, j) => norm(vals[j] ?? ''));
    t.rows.push(row);
    return `✅ 已追加第 ${t.rows.length} 行：${row.map((v, j) => `${t.header[j]}=${v}`).join('，')}`;
  });

  A['doc.tableAddColumn'] = async (a) => withTable(a.doc, '加一列', (t) => {
    const name = norm(a.name);
    if (!name) return '❌ 缺少 name';
    if (t.header.includes(name)) return `❌ 列「${name}」已存在`;
    const vals = arr(a.values);
    t.header.push(name);
    t.rows.forEach((r, i) => r.push(norm(vals[i] ?? '')));
    return `✅ 已追加列「${name}」（现 ${t.header.length} 列）`;
  });

  A['doc.tableDeleteRow'] = async (a) => withTable(a.doc, '删一行', (t) => {
    const ri = Math.round(num(a.row, 0)) - 1;
    if (!(ri >= 0 && ri < t.rows.length)) return `❌ row 超出范围（1..${t.rows.length}）`;
    const [gone] = t.rows.splice(ri, 1);
    return `✅ 已删除第 ${ri + 1} 行（${gone.join('，')}），剩 ${t.rows.length} 行`;
  });

  A['doc.tableToCards'] = async (a) => {
    const c = await freshContent(ctx.projectId);
    const doc = pickDoc(c, a.doc);
    if (!doc) return `❌ 找不到文档「${norm(a.doc)}」`;
    if (doc.kind !== 'table' || !doc.table) return `❌「${doc.title}」不是表格文档`;
    const t = doc.table;
    if (!t.rows.length) return '❌ 表格没有数据行';

    const deck = pickDeck(c, a.deck);
    if (!deck) return `❌ 找不到牌组「${norm(a.deck)}」。现有牌组：${deckNames(c)}`;
    const mode = norm(a.mode) === 'replace' ? 'replace' : 'append';
    const deckId = deck.id;
    const header = t.header.slice();
    let out = '';
    await ctx.update((cc) => {
      const d = cc.decks.find((x) => x.id === deckId);
      if (!d) { out = '❌ 牌组已不存在'; return; }
      d.fields ??= [];
      // 表头 → 字段：同名/id 复用，否则新建
      const fids = header.map((h) => {
        const key = norm(h);
        const exist = d.fields.find((f) => f.id === key || f.name === key);
        if (exist) return exist.id;
        const isCount = /^(数量|count|份数)$/i.test(key);
        const id = isCount ? 'count' : uid().slice(0, 8);
        if (!d.fields.some((f) => f.id === id)) {
          d.fields.push({ id, name: key || id, type: isCount ? 'number' : 'text', showInTable: true });
        }
        return id;
      });
      const cards = mode === 'replace' ? [] : (d.cards ?? []).slice();
      let n = 0;
      for (const r of t.rows) {
        if (!r.some((v) => norm(v) !== '')) continue;
        const values: Record<string, unknown> = {};
        fids.forEach((fid, j) => {
          const f = d.fields.find((x) => x.id === fid);
          values[fid] = f?.type === 'number' ? (norm(r[j]) === '' ? '' : Number(r[j])) : norm(r[j]);
        });
        if (values.count === '' || values.count === undefined) values.count = 1;
        cards.push({ id: uid(), values });
        n += 1;
      }
      d.cards = cards;
      out = `✅ 已从「${doc.title}」导入 ${n} 条卡牌到「${d.name}」（${mode === 'replace' ? '覆盖' : '追加'}，现共 ${cards.length} 条）`;
    }, '智能体：表格转卡牌');
    return out;
  };

  /* ---------------- 联网 ---------------- */

  A['web.search'] = async (a, signal) => {
    if (ctx.web === false) return '❌ 本会话未开启联网。让用户在「上下文」里打开联网开关。';
    const query = norm(a.query ?? a.q);
    if (!query) return '❌ 缺少 query';
    try {
      const items = await api.webSearch({
        query,
        provider: norm(a.provider) || ctx.webProvider || 'auto',
        api_key: norm(a.apiKey) || ctx.webApiKey || '',
        max_results: Math.max(1, Math.min(20, num(a.maxResults ?? a.n, 8))),
        lang: norm(a.lang) || 'zh',
      }, signal);
      if (!items.length) return '搜索没有返回结果（可能是网络不通或搜索引擎拒绝），可以换关键词或改用 web.fetch 直接抓已知网址。';
      return items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      return `❌ 搜索失败：${(e as Error).message ?? e}`;
    }
  };

  A['web.fetch'] = async (a, signal) => {
    if (ctx.web === false) return '❌ 本会话未开启联网。让用户在「上下文」里打开联网开关。';
    const url = norm(a.url);
    if (!url) return '❌ 缺少 url';
    try {
      const r = await api.webFetch({ url, max_chars: Math.max(500, Math.min(120000, num(a.maxChars, 120000))) }, signal);
      const head = `【${r.title || r.url}】（${r.chars} 字）`;
      return `${head}\n${textPage(r.text || '（页面没有可提取的正文）', a.offset, a.limit)}`;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      return `❌ 抓取失败：${(e as Error).message ?? e}`;
    }
  };

  /* ---------------- 计划 / 待办 ---------------- */

  A['todo.write'] = async (a) => {
    const items = arr(a.items);
    if (!items.length) return '❌ items 为空';
    const todos: TodoItem[] = items.map((raw, i) => {
      const it = raw as Record<string, unknown>;
      const st = norm(it.status ?? it.state);
      const status: TodoItem['status'] =
        st === 'done' || st === 'completed' ? 'done'
          : st === 'in_progress' || st === 'doing' ? 'in_progress'
            : 'pending';
      return { id: norm(it.id) || `t${i + 1}`, text: norm(it.text ?? it.title ?? it.content), status };
    }).filter((t) => t.text);
    if (ctx.setTodos) await ctx.setTodos(todos);
    const done = todos.filter((t) => t.status === 'done').length;
    return `✅ 待办已更新（${done}/${todos.length} 完成）：\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.text}`).join('\n')}`;
  };

  return A;
}

/* ------------------------------------------------------------------ */
/* 项目快照（喂给模型，让它拿到真实的 id）                                */
/* ------------------------------------------------------------------ */

export async function projectOverview(ctx: AgentCtx): Promise<string> {
  const c = await freshContent(ctx.projectId);
  const decks = c.decks ?? [];
  const cards = decks.reduce((n, d) => n + (d.cards?.length ?? 0), 0);
  const copies = decks.reduce(
    (n, d) => n + (d.cards ?? []).reduce((m, x) => m + (Number(x.values?.count ?? 1) || 1), 0),
    0,
  );
  const lines: string[] = [
    `项目「${ctx.projectName}」（id=${ctx.projectId}）`,
    `${decks.length} 个牌组 / ${cards} 条卡牌（展开 ${copies} 张）/ ${c.documents?.length ?? 0} 篇文档`,
    `导出设置：${JSON.stringify(c.settings?.export ?? {})}`,
    '',
  ];
  for (const d of decks) {
    lines.push(`【牌组 ${d.name}】id=${d.id}`);
    lines.push(`  字段：${(d.fields ?? []).map((f) => {
      const opt = f.options?.length ? `[${f.options.join('/')}]` : '';
      return `${f.name}(${f.id}:${f.type}${opt})`;
    }).join('，') || '（无）'}`);
    const front = d.frontLayout;
    const back = d.backLayout;
    lines.push(`  正面版式：${front ? `${front.width}×${front.height}px，${(front.elements ?? []).length} 元素` : '未创建'}`);
    if (front) {
      lines.push(`    ${(front.elements ?? []).slice(0, 40).map((e) => `${e.id}:${e.name}:${e.kind}${e.fieldId ? `→${e.fieldId}` : ''}`).join('，') || '（空）'}`);
    }
    lines.push(`  背面版式：${back ? `${back.width}×${back.height}px，${(back.elements ?? []).length} 元素` : '未创建'}`);
    const cs = d.cards ?? [];
    if (cs.length) {
      lines.push(`  卡牌 ${cs.length} 条，前 ${Math.min(cs.length, 12)} 条：`);
      for (const card of cs.slice(0, 12)) {
        const kv = (d.fields ?? [])
          .filter((f) => card.values?.[f.id] !== undefined && card.values?.[f.id] !== '')
          .map((f) => `${f.name}=${JSON.stringify(card.values[f.id])}`)
          .slice(0, 6)
          .join('，');
        lines.push(`    · ${kv || '（空）'} [${card.id}]`);
      }
      if (cs.length > 12) lines.push(`    …还有 ${cs.length - 12} 条，用 card.list 翻页`);
    } else {
      lines.push('  卡牌：0 条');
    }
    lines.push('');
  }
  if (c.documents?.length) {
    // 标出表格/文本：模型分不清就会拿 doc.update 去改表格，界面上一点变化都没有
    lines.push(`【文档】${c.documents.map((d) => `${d.kind === 'table' ? '📊表格' : '📝文本'} ${d.title}(${d.id})`).join('、')}`);
  }
  // 素材：不列出来的话模型根本不知道库里有什么图，只能凭空编 assetId
  const assetLine = await describeAssets(ctx, 8);
  if (assetLine) lines.push(assetLine);
  return lines.join('\n').trim();
}

