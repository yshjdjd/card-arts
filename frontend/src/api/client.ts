/** 后端 API 客户端。所有请求都可能失败——调用方负责降级到本地。 */

export const API_BASE = (import.meta.env as any).VITE_API_BASE ?? '/api/v1';

export class SyncConflictError extends Error {
  constructor(
    public serverRevision: number,
    public serverContent: unknown,
  ) {
    super('revision 冲突');
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, `网络不可达：${(e as Error).message}`);
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const d = body.detail ?? body;
    throw new SyncConflictError(d.server_revision ?? 0, d.server_content);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface ProjectDTO {
  id: string;
  name: string;
  revision: number;
  content: unknown;
  content_hash?: string;
  deck_count: number;
  card_count: number;
  document_count: number;
  updated_at: string;
  created_at?: string;
}

export interface VersionDTO {
  id: string;
  name: string;
  base_revision: number;
  size_bytes?: number;
  created_at: string;
}

export interface IconDTO {
  id: string;
  name: string;
  author: string;
  url: string;
}

export const api = {
  health: () => req<{ status: string }>('/health'),

  /* ---------- 项目 ---------- */
  listProjects: () => req<{ items: ProjectDTO[] }>('/projects'),
  getProject: (id: string) => req<ProjectDTO>(`/projects/${id}`),
  createProject: (name: string, content: unknown) =>
    req<ProjectDTO>('/projects', { method: 'POST', body: JSON.stringify({ name, content }) }),
  pushProject: (
    id: string,
    body: { base_revision: number; content: unknown; name?: string; force?: boolean },
  ) => req<ProjectDTO>(`/projects/${id}/sync`, { method: 'PUT', body: JSON.stringify(body) }),
  pullProject: (id: string, sinceRevision?: number) =>
    req<{ updated: boolean } & Partial<ProjectDTO>>(
      `/projects/${id}/pull${qs({ since_revision: sinceRevision })}`,
    ),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: 'DELETE' }),

  /* ---------- 版本 ---------- */
  listVersions: (id: string) => req<{ items: VersionDTO[] }>(`/projects/${id}/versions`),
  saveVersion: (
    id: string,
    name: string,
    snapshot: unknown,
    assets: unknown[] = [],
    folders: unknown[] = [],
  ) =>
    req<{ id: string }>(`/projects/${id}/versions`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        project_snapshot: snapshot,
        asset_snapshots: assets,
        folder_snapshots: folders,
      }),
    }),
  restoreVersion: (projectId: string, versionId: string) =>
    req<ProjectDTO>(`/projects/${projectId}/versions/${versionId}/restore`, { method: 'POST' }),

  /* ---------- 素材 ---------- */
  listAssets: (projectId: string, folderId?: string | null, kind?: string) =>
    req<{ items: RemoteAssetDTO[] }>(
      `/assets${qs({ project_id: projectId, folder_id: folderId ?? undefined, kind })}`,
    ),
  getAsset: (id: string) => req<RemoteAssetDTO>(`/assets/${id}`),
  renameAsset: (id: string, name: string) =>
    req<RemoteAssetDTO>(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  moveAsset: (id: string, folderId: string | null) =>
    req<RemoteAssetDTO>(`/assets/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ folder_id: folderId }),
    }),
  deleteAsset: (id: string) => req<void>(`/assets/${id}`, { method: 'DELETE' }),
  cropAsset: (id: string, body: Record<string, unknown>) =>
    req<{ asset: RemoteAssetDTO }>(`/assets/${id}/crop`, { method: 'POST', body: JSON.stringify(body) }),
  /** 后端代抓外链图片入库（前端直接 fetch 会被 CORS 拦，智能体尤其需要这条） */
  importAssetUrl: (body: { url: string; project_id: string; name?: string; folder_id?: string | null }) =>
    req<{ asset: RemoteAssetDTO }>('/assets/import-url', {
      method: 'POST', body: JSON.stringify(body),
    }),

  /* ---------- 素材文件夹 ---------- */
  listFolders: (projectId: string) =>
    req<{ items: Array<{ id: string; name: string; parent_id: string | null }> }>(
      `/assets/folders/list${qs({ project_id: projectId })}`,
    ),
  createFolder: (projectId: string, name: string, parentId?: string | null) =>
    req<{ id: string; name: string; parent_id: string | null }>(
      `/assets/folders${qs({ project_id: projectId })}`,
      { method: 'POST', body: JSON.stringify({ name, parent_id: parentId ?? null }) },
    ),
  renameFolder: (id: string, name: string) =>
    req<{ id: string; name: string }>(`/assets/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: string) => req<void>(`/assets/folders/${id}`, { method: 'DELETE' }),

  /* ---------- 内置图标库 ---------- */
  iconStats: () => req<{ loaded: boolean; count: number; url_prefix: string; license: string }>('/icons/stats'),
  iconAuthors: () => req<{ items: Array<{ author: string; count: number }> }>('/icons/authors'),
  searchIcons: (q: string, opts: { limit?: number; offset?: number; author?: string; color?: string } = {}) =>
    req<{ items: IconDTO[]; total: number; offset: number; limit: number }>(
      `/icons${qs({ q, limit: opts.limit ?? 60, offset: opts.offset ?? 0, author: opts.author, color: opts.color })}`,
    ),
  iconSvgUrl: (iconId: string, color?: string, size?: number) =>
    `${API_BASE}/icons/${iconId}/svg${qs({ color: color?.replace('#', ''), size })}`,
  importIcon: (body: {
    project_id: string;
    icon_id: string;
    name?: string;
    folder_id?: string | null;
    color?: string;
    on_conflict?: 'rename' | 'skip' | 'replace';
  }) => req<{ status: string; asset: RemoteAssetDTO; name: string }>('/icons/import', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  importIconsBatch: (body: {
    project_id: string;
    icon_ids: string[];
    folder_id?: string | null;
    name_template?: string;
    color?: string;
    on_conflict?: 'rename' | 'skip' | 'replace';
  }) => req<{ created: number; total: number; items: unknown[] }>('/icons/import-batch', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  /* ---------- 大模型代理（OpenAI 兼容转发）---------- */
  llmChat: (body: {
    base_url: string;
    api_key: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
    /** OpenAI o 系列的长度字段（与 max_tokens 二选一） */
    max_completion_tokens?: number;
    stream?: boolean;
    /** 厂商特有的思考 / 推理参数，原样合并进上游请求体 */
    extra?: Record<string, unknown>;
  }, signal?: AbortSignal) => req<{ content: string; model: string; usage?: unknown; finish_reason?: string; reasoning?: string }>('/llm/chat', {
    signal,
    method: 'POST',
    body: JSON.stringify(body),
  }),
  llmTest: (body: { base_url: string; api_key: string; model: string }) =>
    req<{ ok: boolean; message: string; models?: string[] }>('/llm/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  llmModels: (body: { base_url: string; api_key: string }) =>
    req<{ models: string[] }>('/llm/models', { method: 'POST', body: JSON.stringify(body) }),

  /* ---------- 联网（后端代跑，绕开浏览器跨域）---------- */
  webSearch: (body: { query: string; provider?: string; api_key?: string; max_results?: number; lang?: string }, signal?: AbortSignal) =>
    req<WebSearchItem[]>('/web/search', { method: 'POST', body: JSON.stringify(body), signal }),
  webFetch: (body: { url: string; max_chars?: number }, signal?: AbortSignal) =>
    req<WebFetchResult>('/web/fetch', { method: 'POST', body: JSON.stringify(body), signal }),
};

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebFetchResult {
  url: string;
  title: string;
  content_type: string;
  text: string;
  chars: number;
}

export interface RemoteAssetDTO {
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
    width?: number;
    height?: number;
    dominant_color?: string;
    icon_id?: string;
    icon_author?: string;
    icon_color?: string;
    source?: string;
  };
  url: string;
  thumb_url?: string | null;
  created_at?: string;
}

/** 素材 / 图标 URL 统一走这里，自动补 API 前缀 */
export function assetUrl(u: string): string {
  if (!u) return '';
  if (/^https?:/.test(u)) return u;
  return u.startsWith('/api') ? u : `${API_BASE}${u.startsWith('/') ? u : `/${u}`}`;
}

export function iconFileUrl(iconId: string): string {
  return `/game-icons/${iconId}.svg`;
}
