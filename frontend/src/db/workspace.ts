/**
 * 本地文件夹工作区（File System Access API）。
 *
 * 目的：让「项目 / 素材 / 版本」不只是浏览器私有 IndexedDB 里的二进制，
 * 而是工作目录下一组看得见、能 git、能直接拷贝的真实文件。
 *
 * 目录结构（素材按文件夹树直存）：
 *   cardarts.json                      索引清单
 *   projects/{名称}-{id8}.json          项目全文（牌组 / 卡牌 / 版式 / 文档）
 *   assets/{文件夹路径}/{文件名}         素材原文件
 *   assets/.assets.json                素材元数据（id / sha256 / 尺寸 / 归属）
 *   versions/{项目}/{序号}-{标签}.json    版本快照
 *
 * 运行时真相源仍是 IndexedDB（读写快、支持事务），文件夹是它的持久化镜像：
 * 每次改动后 debounce 写回；启动时若 IndexedDB 为空则可从文件夹反向导入。
 */
import { api, assetUrl, type RemoteAssetDTO } from '../api/client';
import type { AssetFolder, LocalProject, ProjectContent } from '../lib/types';
import { debounce, safeName } from '../lib/utils';
import { db, getSetting, setSetting } from './schema';

/* ---------------- File System Access API 类型 ---------------- */

export interface FSWritable {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface FSFileHandle {
  name: string;
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FSWritable>;
}

export interface FSDirHandle {
  name: string;
  kind: 'directory';
  queryPermission(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FSDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

/* ---------------- 常量 ---------------- */

const HANDLE_KEY = 'workspace.handle';
const INDEX_FILE = 'cardarts.json';
const ASSET_META = '.assets.json';
const MAX_VERSIONS = 30;

export function isWorkspaceSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/* ---------------- 状态 ---------------- */

export interface WorkspaceInfo {
  connected: boolean;
  name: string;
  /** 已写盘的文件数（最近一次镜像） */
  files: number;
  lastSyncAt?: string;
  writing?: boolean;
}

let handle: FSDirHandle | null = null;
let info: WorkspaceInfo = { connected: false, name: '', files: 0 };
const listeners = new Set<(i: WorkspaceInfo) => void>();

export function getWorkspace(): WorkspaceInfo {
  return info;
}

export function onWorkspaceChange(f: (i: WorkspaceInfo) => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

function setInfo(patch: Partial<WorkspaceInfo>): void {
  info = { ...info, ...patch };
  listeners.forEach((f) => f(info));
}

/* ---------------- 底层文件操作 ---------------- */

async function ensureDir(root: FSDirHandle, segs: string[]): Promise<FSDirHandle> {
  let d = root;
  for (const s of segs) {
    if (!s) continue;
    d = await d.getDirectoryHandle(s, { create: true });
  }
  return d;
}

async function writeFile(dir: FSDirHandle, name: string, data: string | Blob): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
}

async function readText(dir: FSDirHandle, name: string): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch {
    return null;
  }
}

async function readJSON<T>(dir: FSDirHandle, name: string): Promise<T | null> {
  const t = await readText(dir, name);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/** 目录是否已存在某个文件（用于跳过重复写入） */
async function hasFile(dir: FSDirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** 按相对路径（a/b/c.png）判断文件是否已存在 */
async function hasFileByPath(root: FSDirHandle, rel: string): Promise<boolean> {
  const segs = rel.split('/');
  const name = segs.pop()!;
  let dir = root;
  try {
    for (const s of segs) dir = await dir.getDirectoryHandle(s);
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

function projectSlug(p: LocalProject): string {
  return `${safeName(p.name) || 'project'}-${p.id.slice(0, 8)}`;
}

/** 把 folder_id 解析成 '父/子/孙' 形式的路径 */
function folderPath(folderId: string | null | undefined, folders: AssetFolder[]): string {
  if (!folderId) return '';
  const segs: string[] = [];
  let cur = folders.find((f) => f.id === folderId);
  let guard = 0;
  while (cur && guard++ < 12) {
    segs.unshift(safeName(cur.name) || cur.id.slice(0, 8));
    cur = cur.parent_id ? folders.find((f) => f.id === cur!.parent_id) : undefined;
  }
  return segs.join('/');
}

async function getFolders(projectId: string, remoteId: string): Promise<AssetFolder[]> {
  try {
    const r = await api.listFolders(remoteId);
    return (r.items ?? []) as AssetFolder[];
  } catch {
    const local = await db.folders.where('projectId').equals(projectId).toArray();
    return local.map(({ id, name, parent_id }) => ({ id, name, parent_id }));
  }
}

/* ---------------- 连接 / 断开 / 恢复 ---------------- */

export async function connectWorkspace(): Promise<WorkspaceInfo> {
  if (!isWorkspaceSupported()) throw new Error('当前浏览器不支持本地文件夹（需 Chrome / Edge 等 Chromium 内核）');
  const picked = await (
    window as unknown as {
      showDirectoryPicker(opts?: { mode?: 'read' | 'readwrite'; startIn?: unknown }): Promise<FSDirHandle>;
    }
  ).showDirectoryPicker({ mode: 'readwrite' });
  const perm = await picked.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('未获得该文件夹的读写权限');

  handle = picked;
  await setSetting(HANDLE_KEY, picked);
  setInfo({ connected: true, name: picked.name, files: 0 });
  const r = await mirrorAll();
  setInfo({ files: r.files, lastSyncAt: new Date().toISOString() });
  return info;
}

export async function restoreWorkspace(): Promise<boolean> {
  if (!isWorkspaceSupported()) return false;
  if (handle) return true;
  const saved = await getSetting<FSDirHandle | null>(HANDLE_KEY, null);
  if (!saved) return false;
  try {
    const perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      handle = saved;
      setInfo({ connected: true, name: saved.name, files: 0 });
      return true;
    }
    // prompt 状态需要用户手势才能重新授权，这里只标记待恢复
    setInfo({ connected: false, name: saved.name, files: 0 });
    return false;
  } catch {
    return false;
  }
}

/** 用户手势内调用：对已保存但未授权的目录重新申请权限 */
export async function reauthorizeWorkspace(): Promise<boolean> {
  const saved = handle ?? (await getSetting<FSDirHandle | null>(HANDLE_KEY, null));
  if (!saved) return false;
  const perm = await saved.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  handle = saved;
  setInfo({ connected: true, name: saved.name, files: 0 });
  return true;
}

export async function disconnectWorkspace(): Promise<void> {
  handle = null;
  await db.settings.delete(HANDLE_KEY);
  setInfo({ connected: false, name: '', files: 0, lastSyncAt: undefined });
}

/* ---------------- 镜像：IndexedDB / 服务端 → 文件夹 ---------------- */

interface AssetMetaRow {
  id: string;
  name: string;
  path: string;
  projectId: string;
  projectName: string;
  folderId: string | null;
  folderPath: string;
  mime: string;
  size: number;
  sha256: string;
  width?: number;
  height?: number;
  dominant_color?: string;
  source?: string;
}

interface IndexFile {
  app: 'card_arts';
  version: 1;
  updatedAt: string;
  projects: Array<{ id: string; name: string; file: string; updatedAt: string; decks: number; cards: number }>;
  assets: AssetMetaRow[];
  folders: Array<{ id: string; name: string; parent_id: string | null; projectId: string }>;
}

export interface MirrorResult {
  projects: number;
  assets: number;
  versions: number;
  files: number;
}

export interface AssetItem {
  meta: AssetMetaRow;
  /** 惰性取文件本体：只有确实要写盘时才下载 */
  getBlob: () => Promise<Blob | null>;
}

function metaOf(
  p: LocalProject,
  folders: AssetFolder[],
  src: { id: string; name: string; folderId: string | null | undefined; mime: string; size: number; sha256: string },
  extra: Partial<AssetMetaRow> = {},
): AssetMetaRow {
  const fp = folderPath(src.folderId, folders);
  return {
    id: src.id,
    name: safeName(src.name),
    path: `assets/${fp ? `${fp}/` : ''}${safeName(src.name)}`,
    projectId: p.id,
    projectName: p.name,
    folderId: src.folderId ?? null,
    folderPath: fp,
    mime: src.mime,
    size: src.size,
    sha256: src.sha256,
    ...extra,
  };
}

/** 取某个项目下所有素材（服务端优先，离线时退回本地 blob） */
async function collectAssets(p: LocalProject, folders: AssetFolder[]): Promise<AssetItem[]> {
  const remoteId = p.remoteId ?? p.id;
  let remote: RemoteAssetDTO[] = [];
  try {
    const r = await api.listAssets(remoteId);
    remote = r.items ?? [];
  } catch {
    remote = [];
  }
  const local = await db.assets.where('projectId').equals(p.id).toArray();

  const out: AssetItem[] = [];
  const seen = new Set<string>();

  for (const a of remote) {
    seen.add(a.id);
    const meta = metaOf(p, folders, {
      id: a.id, name: a.name, folderId: a.folder_id, mime: a.mime, size: a.size, sha256: a.sha256,
    }, {
      width: a.meta?.width,
      height: a.meta?.height,
      dominant_color: a.meta?.dominant_color,
      source: a.meta?.source ?? (a.meta?.icon_id ? `game-icons:${a.meta.icon_id}` : undefined),
    });
    out.push({
      meta,
      getBlob: async () => {
        try {
          const res = await fetch(assetUrl(a.url));
          return res.ok ? await res.blob() : null;
        } catch {
          return null;
        }
      },
    });
  }

  // 本地独有（还没推到服务端）的素材
  for (const a of local) {
    if (seen.has(a.id)) continue;
    const meta = metaOf(p, folders, {
      id: a.id, name: a.name, folderId: a.folderId, mime: a.mime, size: a.size, sha256: a.sha256,
    });
    out.push({ meta, getBlob: async () => a.blob ?? null });
  }
  return out;
}

/** 镜像单个项目：项目文件 + 素材 + 版本快照 */
export async function mirrorProject(projectId: string): Promise<MirrorResult> {
  const root = handle;
  if (!root) throw new Error('未连接工作区');
  const p = await db.projects.get(projectId);
  if (!p) throw new Error('项目不存在');

  const remoteId = p.remoteId ?? p.id;
  const folders = await getFolders(p.id, remoteId);
  let files = 0;

  /* 1. 项目全文 */
  const projectsDir = await ensureDir(root, ['projects']);
  const fileName = `${projectSlug(p)}.json`;
  await writeFile(projectsDir, fileName, JSON.stringify({
    id: p.id,
    name: p.name,
    content: p.content,
    baseRevision: p.baseRevision,
    localRevision: p.localRevision,
    remoteId: p.remoteId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }, null, 2));
  files++;

  /* 2. 素材（按文件夹树直存） */
  const assetsDir = await ensureDir(root, ['assets']);
  const collected = await collectAssets(p, folders);
  const metaById = new Map<string, AssetMetaRow>();
  const existing = (await readJSON<AssetMetaRow[]>(assetsDir, ASSET_META)) ?? [];
  const existingByPath = new Map(existing.map((e) => [e.path, e]));

  let assets = 0;
  for (const { meta, getBlob } of collected) {
    metaById.set(meta.id, meta);
    const rel = meta.path.replace(/^assets\//, '');
    const prev = existingByPath.get(meta.path);
    // 路径相同且 sha256 未变 → 磁盘上已是最新，跳过下载与写盘
    if (prev && prev.sha256 === meta.sha256 && (await hasFileByPath(assetsDir, rel))) continue;

    const blob = await getBlob();
    if (!blob) continue;
    const segs = rel.split('/');
    const fileNameOnly = segs.pop()!;
    const dir = segs.length ? await ensureDir(assetsDir, segs) : assetsDir;
    // 同名不同内容：追加 hash 前 6 位，避免覆盖
    let finalName = fileNameOnly;
    if (await hasFile(dir, finalName)) {
      const dot = finalName.lastIndexOf('.');
      const stem = dot > 0 ? finalName.slice(0, dot) : finalName;
      const ext = dot > 0 ? finalName.slice(dot) : '';
      finalName = `${stem}-${(meta.sha256 || meta.id).slice(0, 6)}${ext}`;
      meta.path = `assets/${segs.length ? `${segs.join('/')}/` : ''}${finalName}`;
    }
    await writeFile(dir, finalName, blob);
    assets++;
    files++;
  }
  await writeFile(assetsDir, ASSET_META, JSON.stringify([...metaById.values()], null, 2));
  files++;

  /* 3. 版本快照 */
  const hist = await db.history.where('projectId').equals(projectId).toArray();
  const keep = hist.slice(-MAX_VERSIONS);
  let versions = 0;
  if (keep.length) {
    const vDir = await ensureDir(root, ['versions', projectSlug(p)]);
    for (let i = 0; i < keep.length; i++) {
      const h = keep[i];
      const label = safeName(h.label || 'snapshot') || 'snapshot';
      await writeFile(vDir, `${String(i + 1).padStart(3, '0')}-${label}.json`, JSON.stringify({
        projectId,
        label: h.label,
        createdAt: h.createdAt,
        content: JSON.parse(h.snapshot) as ProjectContent,
      }, null, 2));
      versions++;
      files++;
    }
  }

  return { projects: 1, assets, versions, files };
}

/** 全量镜像所有项目并写索引清单 */
export async function mirrorAll(): Promise<MirrorResult> {
  const root = handle;
  if (!root) throw new Error('未连接工作区');

  const projects = await db.projects.toArray();
  const total: MirrorResult = { projects: 0, assets: 0, versions: 0, files: 0 };
  const indexProjects: IndexFile['projects'] = [];
  const allAssets: AssetMetaRow[] = [];
  const allFolders: IndexFile['folders'] = [];

  for (const p of projects) {
    const r = await mirrorProject(p.id);
    total.projects += r.projects;
    total.assets += r.assets;
    total.versions += r.versions;
    total.files += r.files;

    const decks = p.content?.decks ?? [];
    indexProjects.push({
      id: p.id,
      name: p.name,
      file: `projects/${projectSlug(p)}.json`,
      updatedAt: p.updatedAt,
      decks: decks.length,
      cards: decks.reduce((n, d) => n + (d.cards?.length ?? 0), 0),
    });

    const remoteId = p.remoteId ?? p.id;
    const folders = await getFolders(p.id, remoteId);
    for (const f of folders) allFolders.push({ id: f.id, name: f.name, parent_id: f.parent_id ?? null, projectId: p.id });
    const collected = await collectAssetsForIndex(p, folders);
    allAssets.push(...collected);
  }

  const idx: IndexFile = {
    app: 'card_arts',
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: indexProjects,
    assets: allAssets,
    folders: allFolders,
  };
  await writeFile(root, INDEX_FILE, JSON.stringify(idx, null, 2));
  total.files++;

  setInfo({ files: total.files, lastSyncAt: idx.updatedAt });
  return total;
}

/** 索引只需要元数据，取 meta 即可（getBlob 是惰性的，不会触发下载） */
async function collectAssetsForIndex(p: LocalProject, folders: AssetFolder[]): Promise<AssetMetaRow[]> {
  const items = await collectAssets(p, folders);
  return items.map((i) => i.meta);
}

/* ---------------- 自动写回 ---------------- */

let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const runMirror = debounce(async () => {
  if (!handle) return;
  const id = pending;
  pending = null;
  setInfo({ writing: true });
  try {
    const r = id ? await mirrorProject(id) : await mirrorAll();
    setInfo({ files: r.files, lastSyncAt: new Date().toISOString() });
  } catch {
    /* 权限过期或目录被删时静默失败，状态由界面上的重新授权按钮处理 */
  } finally {
    setInfo({ writing: false });
  }
}, 900);

/** 改动后调用；传 projectId 只镜像该项目，不传则全量 */
export function scheduleMirror(projectId?: string): void {
  if (!handle) return;
  if (projectId) pending = projectId;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runMirror(), 900);
}

/* ---------------- 反向导入：文件夹 → IndexedDB ---------------- */

export async function importFromWorkspace(): Promise<{ projects: number; assets: number }> {
  const root = handle;
  if (!root) throw new Error('未连接工作区');
  const idx = await readJSON<IndexFile>(root, INDEX_FILE);
  if (!idx?.projects?.length) return { projects: 0, assets: 0 };

  let n = 0;
  for (const it of idx.projects) {
    const existing = await db.projects.get(it.id);
    if (existing) continue;
    const file = await readJSON<{
      id: string; name: string; content: ProjectContent;
      baseRevision?: number; localRevision?: number; remoteId?: string;
      createdAt?: string; updatedAt?: string;
    }>(root, it.file);
    if (!file?.content) continue;
    await db.projects.put({
      id: file.id ?? it.id,
      name: file.name ?? it.name,
      content: file.content,
      baseRevision: file.baseRevision ?? 0,
      localRevision: file.localRevision ?? 1,
      dirty: true,
      remoteId: file.remoteId,
      createdAt: file.createdAt ?? new Date().toISOString(),
      updatedAt: file.updatedAt ?? new Date().toISOString(),
    });
    n++;
  }

  // 素材只写回本地索引与 blob（服务端 id 保留，重新联网后仍可复用）
  let a = 0;
  for (const m of idx.assets ?? []) {
    if (await db.assets.get(m.id)) continue;
    let blob: Blob | undefined;
    try {
      const segs = m.path.replace(/^assets\//, '').split('/');
      const name = segs.pop()!;
      let dir = await ensureDir(root, ['assets']);
      for (const s of segs) dir = await dir.getDirectoryHandle(s);
      const fh = await dir.getFileHandle(name);
      blob = await (await fh.getFile());
    } catch {
      blob = undefined;
    }
    await db.assets.put({
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      kind: (m.mime?.startsWith('font') || /\.(woff2?|ttf|otf)$/i.test(m.name)) ? 'font' : 'image',
      mime: m.mime || 'application/octet-stream',
      size: m.size ?? blob?.size ?? 0,
      sha256: m.sha256 ?? '',
      blob,
      folderId: m.folderId ?? null,
      state: 'local-only',
      createdAt: new Date().toISOString(),
    });
    a++;
  }

  for (const f of idx.folders ?? []) {
    await db.folders.put({ ...f, projectId: f.projectId });
  }

  return { projects: n, assets: a };
}

/** 删除项目时同步删掉它在文件夹里的文件 */
export async function removeProjectFromWorkspace(projectId: string): Promise<void> {
  const root = handle;
  if (!root) return;
  const p = await db.projects.get(projectId);
  const slug = p ? projectSlug(p) : projectId.slice(0, 8);
  try {
    const dir = await root.getDirectoryHandle('projects');
    for (const k of await collectKeys(dir)) {
      if (k.startsWith(`${slug}-`) || k.includes(projectId.slice(0, 8))) {
        await dir.removeEntry(k).catch(() => undefined);
      }
    }
  } catch {
    /* 目录不存在则忽略 */
  }
  try {
    const vRoot = await root.getDirectoryHandle('versions');
    await vRoot.removeEntry(slug, { recursive: true }).catch(() => undefined);
  } catch {
    /* 忽略 */
  }
}

async function collectKeys(dir: FSDirHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const k of dir.keys()) out.push(k);
  return out;
}

/** 供界面显示的建议路径 */
export function suggestedPath(): string {
  return 'card_arts/workspace';
}
