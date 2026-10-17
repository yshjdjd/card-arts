/** 上传器：客户端算 sha256 → 秒传 / 分片 / 断点续传。 */
import { fontMime } from '../lib/fontIdentity';
import { API_BASE, assetUrl, type RemoteAssetDTO } from './client';

export async function sha256(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface UploadOptions {
  projectId: string;
  folderId?: string | null;
  name?: string;
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

const DIRECT_LIMIT = 4 * 1024 * 1024; // <= 单分片大小时走直通通道

export class Uploader {
  static async upload(file: File, opts: UploadOptions): Promise<RemoteAssetDTO> {
    const mime = fontMime(file.name);
    if (mime && file.type !== mime) file = new File([file], file.name, { type: mime });
    if (file.size <= (opts.chunkSize ?? DIRECT_LIMIT)) {
      return Uploader.direct(file, opts);
    }
    return Uploader.uploadChunks(file, opts);
  }

  static async direct(file: File, opts: UploadOptions): Promise<RemoteAssetDTO> {
    const fd = new FormData();
    fd.append('project_id', opts.projectId);
    if (opts.folderId) fd.append('folder_id', opts.folderId);
    fd.append('file', file, opts.name ?? file.name);
    const res = await fetch(`${API_BASE}/uploads/direct`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`上传失败：${await res.text()}`);
    const body = await res.json();
    opts.onProgress?.(file.size, file.size);
    return body.asset as RemoteAssetDTO;
  }

  static async uploadChunks(file: File, opts: UploadOptions): Promise<RemoteAssetDTO> {
    const hash = await sha256(file);
    const initRes = await fetch(`${API_BASE}/uploads/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: opts.projectId,
        filename: opts.name ?? file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        sha256: hash,
      }),
    });
    if (!initRes.ok) throw new Error(`初始化上传失败：${await initRes.text()}`);
    const init = await initRes.json();

    if (init.instant) {
      opts.onProgress?.(file.size, file.size);
      return init.asset as RemoteAssetDTO; // 秒传
    }

    const { upload_id, chunk_size, chunk_count, received } = init as {
      upload_id: string; chunk_size: number; chunk_count: number; received: number[];
    };
    const done = new Set<number>(received ?? []);
    opts.onProgress?.(done.size, chunk_count);

    for (let i = 0; i < chunk_count; i++) {
      if (done.has(i)) continue;
      const blob = file.slice(i * chunk_size, Math.min((i + 1) * chunk_size, file.size));
      const r = await fetch(`${API_BASE}/uploads/${upload_id}/chunk/${i}`, {
        method: 'PUT',
        body: blob,
      });
      if (!r.ok) throw new Error(`分片 ${i} 上传失败：${await r.text()}`);
      done.add(i);
      opts.onProgress?.(done.size, chunk_count);
    }

    return Uploader.complete(upload_id, { folder_id: opts.folderId, name: opts.name });
  }

  /** 断点续传：查询已收分片后只补缺失的 */
  static async resume(uploadId: string, file: File, opts: UploadOptions): Promise<RemoteAssetDTO> {
    const r = await fetch(`${API_BASE}/uploads/${uploadId}/status`);
    if (!r.ok) throw new Error(`查询断点失败：${await r.text()}`);
    const st = await r.json();
    const done = new Set<number>(st.received ?? []);
    for (let i = 0; i < st.chunk_count; i++) {
      if (done.has(i)) continue;
      const blob = file.slice(i * st.chunk_size, Math.min((i + 1) * st.chunk_size, file.size));
      const rr = await fetch(`${API_BASE}/uploads/${uploadId}/chunk/${i}`, { method: 'PUT', body: blob });
      if (!rr.ok) throw new Error(`分片 ${i} 上传失败`);
      done.add(i);
      opts.onProgress?.(done.size, st.chunk_count);
    }
    return Uploader.complete(uploadId, { folder_id: opts.folderId, name: opts.name });
  }

  static async complete(
    uploadId: string,
    body: { folder_id?: string | null; name?: string } = {},
  ): Promise<RemoteAssetDTO> {
    const r = await fetch(`${API_BASE}/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`合并失败：${await r.text()}`);
    return (await r.json()).asset as RemoteAssetDTO;
  }
}

/** 取素材的预览图 URL（优先 thumb，SVG 直接取原图） */
export function previewUrl(a: RemoteAssetDTO): string {
  if (a.mime === 'image/svg+xml') return assetUrl(a.url);
  return a.thumb_url ? assetUrl(a.thumb_url) : assetUrl(a.url);
}
