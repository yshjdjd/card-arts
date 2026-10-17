/**
 * 素材选择器。
 *
 * 版式编辑器（插图框选图）和卡牌数据页（image 字段选图）共用同一个弹窗，
 * 避免两处各写一套导致行为不一致——之前卡牌数据页根本没有选图入口，
 * 用户只能手填素材 id，所以这里把「浏览 + 上传 + 清除」做成一处。
 */
import React, { useMemo, useRef, useState } from 'react';
import { Modal, Empty, Progress } from './ui';
import { Uploader, previewUrl } from '../api/uploader';
import type { RemoteAssetDTO } from '../api/client';
import { useAssets, useProject } from '../state/store';
import { formatBytes, uid } from '../lib/utils';
import { db } from '../db/schema';
import { fontMime } from '../lib/fontIdentity';

export interface AssetPickerProps {
  /** 只显示这类素材；all = 不筛选 */
  kind?: 'image' | 'font' | 'all';
  /** 当前选中的素材 id */
  value?: string;
  /** 选中（空串表示清除） */
  onPick: (assetId: string) => void;
  onClose: () => void;
  /** 上传后是否立即选中，默认 true */
  selectAfterUpload?: boolean;
}

export function AssetPicker({
  kind = 'image', value, onPick, onClose, selectAfterUpload = true,
}: AssetPickerProps) {
  const { assets, folders, loading, offline, refresh, remoteId } = useAssets();
  const { project } = useProject();
  const pid = project?.id ?? '';
  const [q, setQ] = useState('');
  const [folderId, setFolderId] = useState<string>('');
  const [picked, setPicked] = useState<string>(value ?? '');
  const [uploading, setUploading] = useState<{ name: string; done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    let xs = assets;
    if (kind !== 'all') xs = xs.filter((a) => a.kind === kind);
    if (folderId === '__root') xs = xs.filter((a) => !a.folder_id);
    else if (folderId) xs = xs.filter((a) => a.folder_id === folderId);
    const kw = q.trim().toLowerCase();
    if (kw) xs = xs.filter((a) => a.name.toLowerCase().includes(kw));
    return xs;
  }, [assets, kind, folderId, q]);

  const upload = async (files: FileList | File[]) => {
    const created = await uploadImageFiles(files, {
      projectId: pid,
      remoteId,
      refresh,
      onProgress: (name, done, total) => setUploading({ name, done, total }),
    });
    setUploading(null);
    if (fileRef.current) fileRef.current.value = '';
    if (selectAfterUpload && created.length) setPicked(created[created.length - 1]);
  };

  const confirm = () => { onPick(picked); onClose(); };

  return (
    <Modal
      title="选择素材"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => { onPick(''); onClose(); }}>清除图片</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={confirm}>使用选中素材</button>
        </>
      }
    >
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          className="input" style={{ width: 200 }} placeholder="搜索素材名…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ width: 160 }} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">全部文件夹</option>
          <option value="__root">未归档</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <input
          ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); }}
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>⬆ 上传本地图片</button>
      </div>

      {offline && <div className="small faint" style={{ marginBottom: 8 }}>当前离线，显示的是本地缓存；上传会先存本地，联网后自动同步。</div>}
      {uploading && (
        <div className="small" style={{ marginBottom: 8 }}>
          {uploading.name} <Progress done={uploading.done} total={uploading.total} />
        </div>
      )}

      {loading ? (
        <div className="small faint">加载素材…</div>
      ) : list.length === 0 ? (
        <Empty
          icon="🖼"
          text={assets.length ? '没有匹配的素材' : '素材库里还没有图片'}
          action={<button className="btn sm" onClick={() => fileRef.current?.click()}>上传一张</button>}
        />
      ) : (
        <div className="apick-grid">
          {list.map((a) => (
            <button
              key={a.id}
              className={`apick-item ${picked === a.id ? 'on' : ''}`}
              onClick={() => setPicked(a.id)}
              onDoubleClick={confirm}
              title={`${a.name}（${formatBytes(a.size ?? 0)}）`}
            >
              <img src={previewUrl(a)} alt={a.name} loading="lazy" />
              <span className="apick-name">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** 一行式素材选择：缩略图 + 打开选择器；供版式编辑器与卡牌表格复用 */
export function AssetField({
  value, onChange, kind = 'image', label = '素材',
}: {
  value?: string; onChange: (id: string) => void; kind?: AssetPickerProps['kind']; label?: string;
}) {
  const { assets } = useAssets();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const hit = assets.find((a) => a.id === value);
  return (
    <>
      <button
        className="apick-thumb"
        style={{ width: '100%' }}
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={hit ? hit.name : '点击选择素材'}
      >
        {hit
          ? <img src={previewUrl(hit)} alt={hit.name} />
          : <span className="apick-empty">＋ {label || '选择素材'}</span>}
        {hit && hover && <span className="apick-mask">更换</span>}
      </button>
      <div className="row mt8" style={{ gap: 6 }}>
        <span className="small faint ellipsis">{hit ? hit.name : '未选择'}</span>
        {hit && <button className="btn ghost sm" onClick={() => onChange('')}>清除</button>}
      </div>
      {open && (
        <AssetPicker
          kind={kind} value={value}
          onPick={(id) => { onChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export interface UploadImagesOpts {
  projectId: string;
  /** 解析服务端项目 id，失败返回空串（表示离线） */
  remoteId: () => Promise<string>;
  /** 把素材列表刷回界面 */
  refresh?: () => Promise<void> | void;
  onProgress?: (name: string, done: number, total: number) => void;
}

/**
 * 把若干图片文件传进素材库，返回素材 id 列表。
 *
 * 上传通道两处共用（素材选择器、编辑器拖拽落图），
 * 离线时退化为「存本地 + outbox 补传」，id 立刻可用，所以调用方不用分叉。
 */
export async function uploadImageFiles(files: FileList | File[], opts: UploadImagesOpts): Promise<string[]> {
  const arr = Array.from(files).filter((f) => f.type.startsWith('image/') || fontMime(f.name) === null && /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name));
  if (!arr.length) return [];
  let rid = '';
  try { rid = await opts.remoteId(); } catch { rid = ''; }

  const ids: string[] = [];
  for (const f of arr) {
    opts.onProgress?.(f.name, 0, 1);
    try {
      if (rid) {
        const created = await Uploader.upload(f, {
          projectId: rid,
          onProgress: (d, t) => opts.onProgress?.(f.name, d, t),
        });
        ids.push(created.id);
      } else {
        const id = uid();
        await db.assets.put({
          id, projectId: opts.projectId, name: f.name,
          kind: fontMime(f.name) ? 'font' : 'image',
          mime: fontMime(f.name) || f.type, size: f.size, sha256: '',
          blob: f, folderId: null, state: 'local-only', createdAt: new Date().toISOString(),
        });
        await db.outbox.add({
          projectId: opts.projectId, op: 'upload-asset', payload: { assetId: id },
          createdAt: new Date().toISOString(), attempts: 0,
        });
        ids.push(id);
      }
    } catch { /* 单个失败不拖累其他文件 */ }
    opts.onProgress?.(f.name, 1, 1);
  }
  await opts.refresh?.();
  return ids;
}

