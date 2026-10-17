import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, emptyContent, mutateProject, stepProjectHistory, uid } from '../db/schema';
import { flush, getSyncState, onSyncStateChange, startAutoSync, type SyncState } from '../db/sync';
import {
  connectWorkspace, disconnectWorkspace, getWorkspace, importFromWorkspace, isWorkspaceSupported,
  mirrorAll, onWorkspaceChange, reauthorizeWorkspace, restoreWorkspace,
  type MirrorResult, type WorkspaceInfo,
} from '../db/workspace';
import { api, type RemoteAssetDTO } from '../api/client';
import type { AssetFolder, LocalProject, ProjectContent } from '../lib/types';

/* ---------------- 路由 ---------------- */

export interface Route {
  name: 'dashboard' | 'project' | 'print';
  projectId?: string;
  tab?: string;
}

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = h.split('/');
  if (a === 'p' && b) return { name: 'project', projectId: b, tab: c || 'cards' };
  if (a === 'print' && b) return { name: 'print', projectId: b };
  return { name: 'dashboard' };
}

export function navigate(to: string): void {
  location.hash = to.startsWith('#') ? to : `#/${to}`;
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(parseHash);
  useEffect(() => {
    const f = () => setR(parseHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return r;
}

/* ---------------- 全局应用状态 ---------------- */

interface AppCtx {
  syncState: SyncState;
  online: boolean;
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
  syncNow: () => Promise<void>;
  /** 本地文件夹工作区 */
  workspace: WorkspaceInfo;
  workspaceSupported: boolean;
  connectWorkspace: () => Promise<void>;
  disconnectWorkspace: () => Promise<void>;
  reauthorizeWorkspace: () => Promise<boolean>;
  mirrorNow: () => Promise<MirrorResult>;
  importFromWorkspace: () => Promise<{ projects: number; assets: number }>;
}

const AppContext = createContext<AppCtx>({
  syncState: 'idle', online: false, theme: 'light',
  setTheme: () => {}, syncNow: async () => {},
  workspace: { connected: false, name: '', files: 0 },
  workspaceSupported: false,
  connectWorkspace: async () => {}, disconnectWorkspace: async () => {},
  reauthorizeWorkspace: async () => false,
  mirrorNow: async () => ({ projects: 0, assets: 0, versions: 0, files: 0 }),
  importFromWorkspace: async () => ({ projects: 0, assets: 0 }),
});

export const useApp = () => useContext(AppContext);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [syncState, setSyncState] = useState<SyncState>(getSyncState());
  const [online, setOnline] = useState(navigator.onLine);
  const [theme, setThemeState] = useState<'light' | 'dark'>(
    (localStorage.getItem('cardarts.theme') as 'light' | 'dark') ?? 'light',
  );
  const [workspace, setWorkspace] = useState<WorkspaceInfo>(getWorkspace());

  useEffect(() => onSyncStateChange(setSyncState), []);
  useEffect(() => onWorkspaceChange(setWorkspace), []);

  // 启动时恢复上次授权的文件夹（权限仍有效则自动连接）
  useEffect(() => {
    void restoreWorkspace().then((ok) => {
      if (ok) setWorkspace(getWorkspace());
    });
  }, []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cardarts.theme', theme);
  }, [theme]);

  useEffect(() => startAutoSync(15000), []);

  const syncNow = useCallback(async () => {
    try {
      await flush();
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  const connect = useCallback(async () => {
    await connectWorkspace();
    setWorkspace(getWorkspace());
  }, []);

  const disconnect = useCallback(async () => {
    await disconnectWorkspace();
    setWorkspace(getWorkspace());
  }, []);

  const reauth = useCallback(async () => {
    const ok = await reauthorizeWorkspace();
    setWorkspace(getWorkspace());
    return ok;
  }, []);

  const mirrorNow = useCallback(async () => {
    const r = await mirrorAll();
    setWorkspace(getWorkspace());
    return r;
  }, []);

  const importFrom = useCallback(async () => {
    const r = await importFromWorkspace();
    setWorkspace(getWorkspace());
    return r;
  }, []);

  const value = useMemo(
    () => ({
      syncState, online, theme, setTheme: setThemeState, syncNow,
      workspace, workspaceSupported: isWorkspaceSupported(),
      connectWorkspace: connect, disconnectWorkspace: disconnect,
      reauthorizeWorkspace: reauth, mirrorNow, importFromWorkspace: importFrom,
    }),
    [syncState, online, theme, syncNow, workspace, connect, disconnect, reauth, mirrorNow, importFrom],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/* ---------------- 项目列表 ---------------- */

export function useProjects(): LocalProject[] | undefined {
  return useLiveQuery(() => db.projects.orderBy('updatedAt').reverse().toArray(), [], undefined);
}

export function useProjectList(): {
  projects: LocalProject[] | undefined;
  create: (name: string) => Promise<LocalProject>;
  importJSON: (json: unknown, name?: string) => Promise<LocalProject>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
} {
  const projects = useProjects();

  const create = useCallback(async (name: string) => {
    const { createLocalProject } = await import('../db/schema');
    const p = await createLocalProject(name);
    void flush().catch(() => {});
    return p;
  }, []);

  const importJSON = useCallback(async (json: unknown, name?: string) => {
    const j = json as Partial<LocalProject> & { content?: ProjectContent };
    const now = new Date().toISOString();
    const p: LocalProject = {
      id: uid(),
      name: name ?? j?.name ?? '导入的项目',
      content: (j?.content ?? emptyContent()) as ProjectContent,
      baseRevision: 0,
      localRevision: 1,
      dirty: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.projects.put(p);
    await db.outbox.add({ projectId: p.id, op: 'push-project', payload: { create: true }, createdAt: now, attempts: 0 });
    void flush().catch(() => {});
    void import('../db/workspace').then((m) => m.scheduleMirror(p.id));
    return p;
  }, []);

  const remove = useCallback(async (id: string) => {
    const p = await db.projects.get(id);
    if (p?.remoteId) { try { await api.deleteProject(p.remoteId); } catch { /* 离线时仅删本地 */ } }
    await db.projects.delete(id);
    await db.assets.where('projectId').equals(id).delete();
    await db.history.where('projectId').equals(id).delete();
    await db.outbox.where('projectId').equals(id).delete();
    const ws = await import('../db/workspace');
    await ws.removeProjectFromWorkspace(id);
    ws.scheduleMirror();
  }, []);

  const duplicate = useCallback(async (id: string) => {
    const p = await db.projects.get(id);
    if (!p) return;
    const now = new Date().toISOString();
    const copy: LocalProject = {
      ...p,
      id: uid(),
      name: `${p.name} 副本`,
      baseRevision: 0,
      localRevision: 1,
      dirty: true,
      remoteId: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await db.projects.put(copy);
    await db.outbox.add({ projectId: copy.id, op: 'push-project', payload: { create: true }, createdAt: now, attempts: 0 });
    void import('../db/workspace').then((m) => m.scheduleMirror(copy.id));
  }, []);

  return { projects, create, importJSON, remove, duplicate };
}

/* ---------------- 单个项目 ---------------- */

interface ProjectCtx {
  project: LocalProject | undefined;
  content: ProjectContent;
  update: (fn: (c: ProjectContent) => void, label?: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

const ProjectContext = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error('useProject 必须在 ProjectProvider 内使用');
  return c;
}

export function ProjectProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const project = useLiveQuery(() => db.projects.get(projectId), [projectId], undefined);
  // 撤销/重做栈：history 表的游标
  const [undoStack, setUndoStack] = useState<number[]>([]);
  const redoEntry = useLiveQuery(() => db.settings.get(`redo:${projectId}`), [projectId]);
  const redoCount = Array.isArray(redoEntry?.value) ? redoEntry.value.length : 0;

  const refreshStacks = useCallback(async () => {
    const keys = await db.history.where('projectId').equals(projectId).primaryKeys();
    setUndoStack(keys as number[]);
  }, [projectId]);

  useEffect(() => { void refreshStacks(); }, [refreshStacks, project?.localRevision]);

  const update = useCallback(
    async (fn: (c: ProjectContent) => void, label = '编辑') => {
      await mutateProject(projectId, (p) => fn(p.content), label);
      await refreshStacks();
      // 空闲时自动同步
      window.setTimeout(() => { void flush().catch(() => {}); }, 400);
    },
    [projectId, refreshStacks],
  );

  const rename = useCallback(
    async (name: string) => {
      await mutateProject(projectId, () => {}, '重命名');
      await db.projects.update(projectId, { name, updatedAt: new Date().toISOString() });
      window.setTimeout(() => { void flush().catch(() => {}); }, 400);
    },
    [projectId],
  );

  const undo = useCallback(async () => {
    await stepProjectHistory(projectId, 'undo');
    await refreshStacks(); void flush().catch(() => {});
  }, [projectId, refreshStacks]);
  const redo = useCallback(async () => {
    await stepProjectHistory(projectId, 'redo');
    await refreshStacks(); void flush().catch(() => {});
  }, [projectId, refreshStacks]);

  const value = useMemo<ProjectCtx>(
    () => ({
      project,
      content: project?.content ?? emptyContent(),
      update,
      rename,
      undo,
      redo,
      canUndo: undoStack.length > 0,
      canRedo: redoCount > 0,
    }),
    [project, update, rename, undo, redo, undoStack.length, redoCount],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/* ---------------- 素材 ---------------- */

export interface AssetsState {
  assets: RemoteAssetDTO[];
  folders: AssetFolder[];
  loading: boolean;
  offline: boolean;
  refresh: () => Promise<void>;
  /** 素材归属的服务端项目 id（本地项目尚未推送时会自动创建） */
  remoteId: () => Promise<string>;
  addFolder: (name: string, parentId?: string | null) => Promise<AssetFolder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  renameAsset: (id: string, name: string) => Promise<void>;
  moveAsset: (id: string, folderId: string | null) => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
}

const AssetsContext = createContext<AssetsState | null>(null);

export function useAssets(): AssetsState {
  const c = useContext(AssetsContext);
  if (!c) throw new Error('useAssets 必须在 AssetsProvider 内使用');
  return c;
}

export function AssetsProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const localProject = useLiveQuery(() => db.projects.get(projectId), [projectId], undefined);
  const [assets, setAssets] = useState<RemoteAssetDTO[]>([]);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  // 服务端按「服务端项目 id」组织素材，本地项目要先解析出 remoteId
  const remoteId = localProject?.remoteId ?? projectId;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [a, f] = await Promise.all([api.listAssets(remoteId), api.listFolders(remoteId)]);
      setAssets(a.items ?? []);
      setFolders((f.items ?? []) as AssetFolder[]);
      setOffline(false);
      // 本地缓存一份，离线时可读
      await db.folders.where('projectId').equals(projectId).delete();
      await db.folders.bulkPut((f.items ?? []).map((x) => ({ ...x, projectId })) as (AssetFolder & { projectId: string })[]);
    } catch {
      setOffline(true);
      const local = await db.folders.where('projectId').equals(projectId).toArray();
      setFolders(local);
      const la = await db.assets.where('projectId').equals(projectId).toArray();
      setAssets(
        la.map((x) => ({
          id: x.id, project_id: x.projectId, folder_id: x.folderId ?? null, name: x.name,
          kind: x.kind, mime: x.mime, size: x.size, sha256: x.sha256,
          variants: {}, meta: {}, url: '', thumb_url: null,
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [projectId, remoteId]);

  /** 素材必须挂在服务端项目下；本地项目还没推上去时先建一个 */
  const ensureRemote = useCallback(async (): Promise<string> => {
    if (localProject?.remoteId) return localProject.remoteId;
    const res = await api.createProject(localProject?.name ?? '未命名项目', localProject?.content ?? {});
    await db.projects.update(projectId, { remoteId: res.id, baseRevision: res.revision });
    return res.id;
  }, [localProject, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 素材 / 文件夹变动后写回本地文件夹工作区 */
  const mirror = useCallback(() => {
    void import('../db/workspace').then((m) => m.scheduleMirror(projectId));
  }, [projectId]);

  const addFolder = useCallback(
    async (name: string, parentId: string | null = null) => {
      try {
        const rid = await ensureRemote();
        const f = await api.createFolder(rid, name, parentId);
        await refresh();
        mirror();
        return f as AssetFolder;
      } catch {
        const local: AssetFolder & { projectId: string } = { id: uid(), name, parent_id: parentId, projectId };
        await db.folders.put(local);
        setFolders((s) => [...s, local]);
        mirror();
        return local;
      }
    },
    [projectId, refresh, ensureRemote, mirror],
  );

  const renameFolder = useCallback(async (id: string, name: string) => {
    setFolders((s) => s.map((f) => (f.id === id ? { ...f, name } : f)));
    try { await api.renameFolder(id, name); } catch { await db.folders.update(id, { name }); }
    mirror();
  }, [mirror]);

  const deleteFolder = useCallback(async (id: string) => {
    setFolders((s) => s.filter((f) => f.id !== id));
    setAssets((s) => s.filter((a) => a.folder_id !== id));
    try { await api.deleteFolder(id); } catch { await db.folders.delete(id); }
    mirror();
  }, [mirror]);

  const renameAsset = useCallback(async (id: string, name: string) => {
    setAssets((s) => s.map((a) => (a.id === id ? { ...a, name } : a)));
    try { await api.renameAsset(id, name); } catch { await db.assets.update(id, { name }); }
    mirror();
  }, [mirror]);

  const moveAsset = useCallback(async (id: string, folderId: string | null) => {
    setAssets((s) => s.map((a) => (a.id === id ? { ...a, folder_id: folderId } : a)));
    try { await api.moveAsset(id, folderId); } catch { await db.assets.update(id, { folderId }); }
    mirror();
  }, [mirror]);

  const deleteAsset = useCallback(async (id: string) => {
    setAssets((s) => s.filter((a) => a.id !== id));
    try { await api.deleteAsset(id); } catch { await db.assets.delete(id); }
    mirror();
  }, [mirror]);

  const value = useMemo(
    () => ({
      assets, folders, loading, offline, refresh, remoteId: ensureRemote,
      addFolder, renameFolder, deleteFolder, renameAsset, moveAsset, deleteAsset,
    }),
    [assets, folders, loading, offline, refresh, ensureRemote, addFolder, renameFolder, deleteFolder, renameAsset, moveAsset, deleteAsset],
  );

  return <AssetsContext.Provider value={value}>{children}</AssetsContext.Provider>;
}
