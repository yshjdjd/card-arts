/**
 * 本地优先存储层（Dexie / IndexedDB）。
 *
 * 设计要点：
 *   1. 所有写操作先落本地，再进 `outbox` 待推送队列，离线也能正常编辑；
 *   2. 项目带 baseRevision / localRevision / dirty，用于与服务端乐观并发；
 *   3. 素材本地存 blob 并标记同步状态；
 *   4. `history` 表保存撤销/重做快照（每个项目保留最近 N 步）。
 */
import Dexie, { type Table } from 'dexie';
import type {
  AgentContext, AssetFolder, ChatSession, Field, Layout, LLMConfig, LocalAsset, LocalProject,
  ProjectContent, TodoItem,
} from '../lib/types';
import { defaultLLMConfig } from '../lib/llm';

export interface OutboxItem {
  id?: number;
  projectId: string;
  op: 'push-project' | 'upload-asset' | 'delete-asset';
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface HistoryItem {
  id?: number;
  projectId: string;
  label: string;
  snapshot: string; // JSON 字符串，避免结构化克隆大对象时的性能问题
  createdAt: string;
}

export interface AppSettings {
  key: string;
  value: unknown;
}

export class CardArtsDB extends Dexie {
  projects!: Table<LocalProject, string>;
  assets!: Table<LocalAsset, string>;
  folders!: Table<AssetFolder & { projectId: string }, string>;
  outbox!: Table<OutboxItem, number>;
  history!: Table<HistoryItem, number>;
  settings!: Table<AppSettings, string>;
  /** v2：项目内的多会话 */
  chats!: Table<ChatSession, string>;

  constructor() {
    super('card_arts');
    this.version(1).stores({
      projects: 'id, name, updatedAt, dirty',
      assets: 'id, projectId, sha256, state, folderId',
      folders: 'id, projectId, name',
      outbox: '++id, projectId, op, createdAt',
      history: '++id, projectId, createdAt',
      settings: 'key',
    });
    this.version(2).stores({
      chats: 'id, projectId, updatedAt, title',
    });
  }
}

export const db = new CardArtsDB();

/* ---------------- 默认结构 ---------------- */

export const uid = (): string =>
  (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

export function emptyLayout(name: string, w = 750, h = 1050, wMm = 63.5, hMm = 88.9): Layout {
  return {
    id: uid(),
    name,
    width: w,
    height: h,
    widthMm: wMm,
    heightMm: hMm,
    backgroundColor: '#ffffff',
    borderColor: '#e5e7eb',
    borderWidth: 1,
    borderRadius: 24,
    elements: [],
  };
}

export function defaultFields(): Field[] {
  return [
    { id: 'name', name: '名称', type: 'text', showInTable: true },
    { id: 'count', name: '数量', type: 'number', showInTable: true },
  ];
}

/** 新建项目的默认结构（与原项目一致：内置 name / count 字段 + 一副空牌组） */
export function emptyContent(): ProjectContent {
  const deckId = uid();
  return {
    decks: [
      {
        id: deckId,
        name: '主牌组',
        fields: defaultFields(),
        cards: [],
        frontLayout: emptyLayout('正面'),
        backLayout: emptyLayout('背面'),
        useSharedBack: true,
      },
    ],
    documents: [],
    settings: { lang: 'zh', syncEnabled: true },
  };
}

export async function createLocalProject(name: string): Promise<LocalProject> {
  const now = new Date().toISOString();
  const p: LocalProject = {
    id: uid(),
    name,
    content: emptyContent(),
    baseRevision: 0,
    localRevision: 1,
    dirty: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.projects.put(p);
  await db.outbox.add({
    projectId: p.id,
    op: 'push-project',
    payload: { create: true },
    createdAt: now,
    attempts: 0,
  });
  void import('./workspace').then((m) => m.scheduleMirror(p.id));
  return p;
}

/** 所有写操作都走这里：先改本地，再入队待同步 */
export async function mutateProject(
  projectId: string,
  fn: (p: LocalProject) => void,
  label = '编辑',
): Promise<void> {
  await db.transaction('rw', db.projects, db.outbox, db.history, db.settings, async () => {
    const p = await db.projects.get(projectId);
    if (!p) throw new Error('项目不存在');

    // 撤销快照（限长 60）
    await db.history.add({
      projectId,
      label,
      snapshot: JSON.stringify(p.content),
      createdAt: new Date().toISOString(),
    });
    const old = await db.history.where('projectId').equals(projectId).primaryKeys();
    if (old.length > 60) {
      await db.history.bulkDelete(old.slice(0, old.length - 60));
    }

    await db.settings.delete(`redo:${projectId}`);
    fn(p);
    p.localRevision += 1;
    p.dirty = true;
    p.updatedAt = new Date().toISOString();
    await db.projects.put(p);
    await db.outbox.add({
      projectId,
      op: 'push-project',
      payload: {},
      createdAt: new Date().toISOString(),
      attempts: 0,
    });
  });

  // 事务提交后再写回本地文件夹工作区（动态 import 避免与 workspace 模块循环依赖）
  void import('./workspace').then((m) => m.scheduleMirror(projectId));
}

/** Undo/redo snapshots are stored atomically with project changes, including after reload. */
export async function stepProjectHistory(projectId: string, direction: 'undo' | 'redo'): Promise<boolean> {
  const changed = await db.transaction('rw', db.projects, db.outbox, db.history, db.settings, async () => {
    const p = await db.projects.get(projectId); if (!p) return false;
    const key = `redo:${projectId}`;
    const redo = ((await db.settings.get(key))?.value ?? []) as { snapshot: string; label: string }[];
    const current = JSON.stringify(p.content);
    if (direction === 'undo') {
      const ids = await db.history.where('projectId').equals(projectId).primaryKeys();
      const id = ids.at(-1); if (id === undefined) return false;
      const entry = await db.history.get(id); if (!entry) return false;
      p.content = JSON.parse(entry.snapshot);
      redo.push({ snapshot: current, label: entry.label });
      await db.history.delete(id);
    } else {
      const entry = redo.pop(); if (!entry) return false;
      await db.history.add({ projectId, snapshot: current, label: entry.label, createdAt: new Date().toISOString() });
      p.content = JSON.parse(entry.snapshot);
    }
    await db.settings.put({ key, value: redo });
    p.localRevision++; p.dirty = true; p.updatedAt = new Date().toISOString();
    await db.projects.put(p);
    await db.outbox.add({ projectId, op: 'push-project', payload: {}, createdAt: p.updatedAt, attempts: 0 });
    return true;
  });
  if (changed) void import('./workspace').then((m) => m.scheduleMirror(projectId));
  return changed;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

/* ---------------- 项目级大模型配置 ---------------- */

const llmKey = (projectId: string) => `llm:${projectId}`;

/**
 * 大模型配置只存本机（按项目 id 隔离），不写进项目文档，
 * 因此不会随同步上传到服务端——API Key 不会离开这台机器。
 */
export async function getLLMConfig(projectId: string): Promise<LLMConfig> {
  const saved = await getSetting<Partial<LLMConfig> | null>(llmKey(projectId), null);
  return { ...defaultLLMConfig(), ...(saved ?? {}) } as LLMConfig;
}

export async function setLLMConfig(projectId: string, cfg: LLMConfig): Promise<void> {
  await setSetting(llmKey(projectId), { ...cfg, updatedAt: new Date().toISOString() });
}

/* ---------------- 智能体上下文（项目级默认） ---------------- */

const agentKey = (projectId: string) => `agentctx:${projectId}`;

export const DEFAULT_AGENT_CONTEXT: AgentContext = { docIds: [], skills: [], web: true, approved: [] };

/** 项目级默认上下文；新会话创建时继承它 */
export async function getAgentContext(projectId: string): Promise<AgentContext> {
  const saved = await getSetting<Partial<AgentContext> | null>(agentKey(projectId), null);
  return { ...DEFAULT_AGENT_CONTEXT, ...(saved ?? {}) };
}

export async function setAgentContext(projectId: string, ctx: AgentContext): Promise<void> {
  await setSetting(agentKey(projectId), ctx);
}

/* ---------------- 会话 ---------------- */

export async function listChats(projectId: string): Promise<ChatSession[]> {
  const rows = await db.chats.where('projectId').equals(projectId).toArray();
  // 最近更新的排最前
  return rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function createChat(projectId: string, title = '新会话'): Promise<ChatSession> {
  const now = new Date().toISOString();
  const base = await getAgentContext(projectId);
  const s: ChatSession = {
    id: uid(), projectId, title, messages: [], createdAt: now, updatedAt: now,
    // 新会话继承项目级默认上下文，之后各会话独立调整
    context: { ...base },
    todos: [],
  };
  await db.chats.put(s);
  return s;
}

/** 就地更新会话的上下文挂载（勾选文档 / 知识包 / 联网开关） */
export async function updateChatContext(id: string, patch: Partial<AgentContext>): Promise<void> {
  const s = await db.chats.get(id);
  if (!s) return;
  const cur = s.context ?? DEFAULT_AGENT_CONTEXT;
  const next: AgentContext = {
    docIds: patch.docIds ?? cur.docIds,
    skills: patch.skills ?? cur.skills,
    customSkills: patch.customSkills ?? cur.customSkills,
    web: patch.web ?? cur.web,
    webProvider: patch.webProvider ?? cur.webProvider,
    webApiKey: patch.webApiKey ?? cur.webApiKey,
    approved: patch.approved ?? cur.approved,
  };
  await db.chats.update(id, { context: next, updatedAt: new Date().toISOString() });
}

export async function updateChatTodos(id: string, todos: TodoItem[]): Promise<void> {
  await db.chats.update(id, { todos, updatedAt: new Date().toISOString() });
}

export async function renameChat(id: string, title: string): Promise<void> {
  await db.chats.update(id, { title, updatedAt: new Date().toISOString() });
}

export async function deleteChat(id: string): Promise<void> {
  await db.chats.delete(id);
}

export async function appendMessage(
  chatId: string,
  msg: { role: ChatSession['messages'][number]['role']; content: string; mutated?: boolean; reasoning?: string },
): Promise<string | undefined> {
  return db.transaction('rw', db.chats, async () => {
    const s = await db.chats.get(chatId);
    if (!s) return;
    const messageId = uid();
    s.messages.push({
      id: messageId,
      role: msg.role,
      content: msg.content,
      createdAt: new Date().toISOString(),
      mutated: msg.mutated,
      reasoning: msg.reasoning,
    });
    s.updatedAt = new Date().toISOString();
    await db.chats.put(s);
    return messageId;
  });
}

/** 就地更新最后一条助手消息（流式输出时反复调用） */
export async function patchLastMessage(
  chatId: string,
  content: string,
  reasoning?: string,
  messageId?: string,
  agentRun?: ChatSession['messages'][number]['agentRun'],
): Promise<void> {
  await db.transaction('rw', db.chats, async () => {
    const s = await db.chats.get(chatId);
    if (!s || !s.messages.length) return;
    const last = messageId ? s.messages.find((m) => m.id === messageId) : s.messages[s.messages.length - 1];
    if (!last) return;
    if (agentRun) last.agentRun = agentRun;
    last.content = content;
    if (reasoning !== undefined) last.reasoning = reasoning;
    s.updatedAt = new Date().toISOString();
    await db.chats.put(s);
  });
}

export async function clearChatMessages(id: string): Promise<void> {
  const s = await db.chats.get(id);
  if (!s) return;
  await db.chats.put({ ...s, messages: [], updatedAt: new Date().toISOString() });
}
