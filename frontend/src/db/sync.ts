/**
 * 同步引擎：本地优先，联网后把 outbox 队列顺序回放。
 *
 * 冲突策略（默认 last-write-wins + 保留对方副本）：
 *   - push 返回 409 → 拉取服务端内容，若本地 revision 更新则用 force 覆盖；
 *     否则以服务端为准，把本地旧版本另存为「冲突副本」项目，绝不丢数据。
 */
import { api, SyncConflictError } from '../api/client';
import type { ProjectContent } from '../lib/types';
import { db, uid } from './schema';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

let state: SyncState = 'idle';
const listeners = new Set<(s: SyncState) => void>();

export function getSyncState(): SyncState {
  return state;
}

function setSyncState(s: SyncState): void {
  state = s;
  listeners.forEach((f) => f(s));
}

export function onSyncStateChange(f: (s: SyncState) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export async function isOnline(): Promise<boolean> {
  try {
    await api.health();
    return true;
  } catch {
    return false;
  }
}

/** 回放 outbox 中某个项目的待推送操作 */
async function pushProjectItem(projectId: string, payload: Record<string, unknown>): Promise<void> {
  const p = await db.projects.get(projectId);
  if (!p) return;

  if (payload.create && !p.remoteId) {
    const created = await api.createProject(p.name, p.content);
    await db.projects.update(projectId, {
      remoteId: created.id,
      baseRevision: created.revision,
      dirty: false,
    });
    return;
  }

  const remoteId = p.remoteId ?? projectId;
  try {
    const res = await api.pushProject(remoteId, {
      base_revision: p.baseRevision,
      content: p.content as unknown as Record<string, unknown>,
      name: p.name,
    });
    await db.projects.update(projectId, {
      remoteId: remoteId,
      baseRevision: res.revision,
      dirty: false,
    });
  } catch (e) {
    if (e instanceof SyncConflictError) {
      const mine = p.localRevision;
      const theirs = e.serverRevision;
      if (mine >= theirs) {
        const res = await api.pushProject(remoteId, {
          base_revision: theirs,
          content: p.content as unknown as Record<string, unknown>,
          name: p.name,
          force: true,
        });
        await db.projects.update(projectId, { baseRevision: res.revision, dirty: false });
        return;
      }
      // 服务端更新：保留本地副本，再采用服务端内容
      await db.projects.put({
        ...p,
        id: uid(),
        name: `${p.name}（冲突副本 ${new Date().toLocaleString('zh-CN')}）`,
        dirty: true,
        baseRevision: 0,
        remoteId: undefined,
      });
      await db.projects.update(projectId, {
        content: e.serverContent as ProjectContent,
        baseRevision: theirs,
        localRevision: theirs,
        dirty: false,
      });
      return;
    }
    throw e;
  }
}

/** 把本地素材 blob 推到服务端 */
async function pushAsset(payload: Record<string, unknown>): Promise<void> {
  const { assetId } = payload as { assetId: string };
  const a = await db.assets.get(assetId);
  if (!a || !a.blob || a.state === 'synced') return;
  const { Uploader } = await import('../api/uploader');
  try {
    const remote = await Uploader.upload(new File([a.blob], a.name, { type: a.mime }), {
      projectId: (await db.projects.get(a.projectId))?.remoteId || a.projectId,
      folderId: a.folderId,
      name: a.name,
    });
    await db.assets.update(assetId, { remoteId: remote.id, state: 'synced' });
    if (a.kind === 'font' && remote.id !== assetId) {
      await db.transaction('rw', db.projects, db.outbox, async () => {
        const project = await db.projects.get(a.projectId); if (!project) return;
        const before = `asset:${assetId}`, after = `asset:${remote.id}`;
        let changed = false;
        if (project.content.settings?.defaultFont === before) { project.content.settings.defaultFont = after; changed = true; }
        for (const deck of project.content.decks) {
          for (const layout of [deck.frontLayout, deck.backLayout]) for (const el of layout?.elements || []) if (el.fontFamily === before) { el.fontFamily = after; changed = true; }
          for (const card of deck.cards) for (const override of Object.values(card.layoutOverrides || {})) if (override.fontFamily === before) { override.fontFamily = after; changed = true; }
        }
        if (changed) {
          project.dirty = true; project.localRevision++; await db.projects.put(project);
          await db.outbox.add({ projectId: project.id, op: 'push-project', payload: {}, createdAt: new Date().toISOString(), attempts: 0 });
        }
      });
    }
  } catch (e) {
    await db.assets.update(assetId, { state: 'failed' });
    throw e;
  }
}

export async function flush(): Promise<void> {
  if (state === 'syncing') return;
  setSyncState('syncing');
  try {
    const items = await db.outbox.orderBy('id').toArray();
    for (const it of items) {
      try {
        if (it.op === 'push-project') {
          await pushProjectItem(it.projectId, (it.payload as Record<string, unknown>) ?? {});
        } else if (it.op === 'upload-asset') {
          await pushAsset((it.payload as Record<string, unknown>) ?? {});
        }
        await db.outbox.delete(it.id!);
      } catch (e) {
        const attempts = (it.attempts ?? 0) + 1;
        if (attempts >= 5) {
          await db.outbox.delete(it.id!);
        } else {
          await db.outbox.update(it.id!, { attempts, lastError: (e as Error).message });
        }
        throw e;
      }
    }
    setSyncState('idle');
  } catch (e) {
    setSyncState((e as Error).message.includes('网络不可达') ? 'offline' : 'error');
    throw e;
  }
}

/** 拉取服务端全部项目，写入本地（仅用于「从云端导入」） */
export async function pullAll(): Promise<number> {
  const { items } = await api.listProjects();
  let n = 0;
  for (const it of items) {
    const local = await db.projects.where('id').equals(it.id).first();
    const existing = local ?? (await db.projects.filter((p) => p.remoteId === it.id).first());
    if (existing) continue;
    const full = await api.getProject(it.id);
    await db.projects.put({
      id: uid(),
      remoteId: it.id,
      name: full.name,
      content: full.content as ProjectContent,
      baseRevision: full.revision,
      localRevision: full.revision,
      dirty: false,
      createdAt: full.created_at ?? new Date().toISOString(),
      updatedAt: full.updated_at,
    });
    n++;
  }
  return n;
}

/** 单项目拉取 */
export async function pullProject(projectId: string): Promise<boolean> {
  const p = await db.projects.get(projectId);
  if (!p?.remoteId) return false;
  const res = await api.pullProject(p.remoteId, p.baseRevision);
  if (!res.updated) return false;
  await db.projects.update(projectId, {
    content: res.content as ProjectContent,
    baseRevision: res.revision ?? p.baseRevision,
    dirty: false,
  });
  return true;
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startAutoSync(intervalMs = 15000): () => void {
  if (timer) clearInterval(timer);
  const tick = async () => {
    const pending = await db.outbox.count();
    if (pending > 0) {
      try {
        await flush();
      } catch {
        /* 下一轮重试 */
      }
    }
  };
  timer = setInterval(tick, intervalMs);
  void tick();
  window.addEventListener('online', tick);

  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    window.removeEventListener('online', tick);
  };
}
