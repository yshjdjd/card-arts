import { fontMime } from '../lib/fontIdentity';
import React, { useMemo, useRef, useState } from 'react';
import { useAssets, useProject } from '../state/store';
import { useToast, useConfirm, Modal, Empty, Progress, Select, Field as F } from '../components/ui';
import { api, assetUrl, type RemoteAssetDTO } from '../api/client';
import { Uploader, previewUrl, sha256 } from '../api/uploader';
import { db } from '../db/schema';
import { formatBytes, formatDate, safeName, uid } from '../lib/utils';
import { CARD_PRESETS, presetByKey } from '../lib/presets';

export default function AssetsPage() {
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const { assets, folders, loading, offline, refresh, remoteId, addFolder, renameFolder, deleteFolder, renameAsset, moveAsset, deleteAsset } = useAssets();
  const { project } = useProject();

  const [folderId, setFolderId] = useState<string>(''); // '' = 全部
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<{ name: string; done: number; total: number } | null>(null);
  const [detail, setDetail] = useState<RemoteAssetDTO | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const byFolder = useMemo(() => {
    if (!folderId) return assets;
    return assets.filter((a) => (folderId === '__root' ? !a.folder_id : a.folder_id === folderId));
  }, [assets, folderId]);

  const countOf = (fid: string) =>
    fid === '__root' ? assets.filter((a) => !a.folder_id).length : assets.filter((a) => a.folder_id === fid).length;

  const doUpload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    let rid = '';
    try {
      rid = await remoteId();
    } catch {
      // 离线：存本地，联网后由 outbox 补传
      for (const f of list) {
        const id = uid();
        await db.assets.put({
          id, projectId: project?.id ?? '', name: f.name, kind: fontMime(f.name) || f.type.startsWith('font') ? 'font' : 'image',
          mime: fontMime(f.name) || f.type, size: f.size, sha256: '', blob: f, folderId: folderId === '__root' ? null : folderId || null,
          state: 'local-only', createdAt: new Date().toISOString(),
        });
        await db.outbox.add({ projectId: project?.id ?? '', op: 'upload-asset', payload: { assetId: id }, createdAt: new Date().toISOString(), attempts: 0 });
      }
      await refresh();
      toast('离线模式：已存到本地，联网后自动上传', 'ok');
      return;
    }

    for (const f of list) {
      setUploading({ name: f.name, done: 0, total: 1 });
      try {
        await Uploader.upload(f, {
          projectId: rid,
          folderId: folderId === '__root' ? null : folderId || null,
          onProgress: (d, t) => setUploading({ name: f.name, done: d, total: t }),
        });
        toast(`「${f.name}」上传完成`, 'ok');
      } catch (e) {
        toast(`「${f.name}」上传失败：${(e as Error).message}`, 'err');
      }
    }
    setUploading(null);
    await refresh();
  };

  const onDelete = async (ids: string[]) => {
    const ok = await ask({ title: '删除素材', text: `确定删除选中的 ${ids.length} 个素材？`, danger: true });
    if (!ok) return;
    for (const id of ids) await deleteAsset(id);
    setSelected(new Set());
    toast('已删除');
  };

  const onMove = async (ids: string[], target: string | null) => {
    for (const id of ids) await moveAsset(id, target);
    setSelected(new Set());
    toast('已移动');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div className="row wrap">
        <button className="btn primary" onClick={() => fileRef.current?.click()}>+ 上传素材</button>
        <button className="btn" onClick={() => setShowNewFolder(true)}>+ 新建文件夹</button>
        <span style={{ flex: 1 }} />
        {offline && <span className="tag warn">离线：显示本地缓存</span>}
        <span className="small muted">{assets.length} 个素材</span>
        <button className="btn sm" onClick={() => void refresh()}>刷新</button>
        <input
          ref={fileRef} type="file" multiple hidden
          accept="image/*,font/*,.woff2,.woff,.ttf,.otf"
          onChange={(e) => { if (e.target.files?.length) void doUpload(e.target.files); e.target.value = ''; }}
        />
      </div>

      {uploading && (
        <div className="card"><div className="bd">
          <div className="small">{uploading.name}</div>
          <div className="mt8"><Progress done={uploading.done} total={uploading.total} /></div>
        </div></div>
      )}

      <div className="assets-wrap card" style={{ flex: 1, minHeight: 0 }}>
        {/* 文件夹 */}
        <div className="folders">
          <div className={`folder-item ${folderId === '' ? 'on' : ''}`} onClick={() => setFolderId('')}>
            <span>📦</span><span style={{ flex: 1 }}>全部素材</span><span className="cnt">{assets.length}</span>
          </div>
          <div className={`folder-item ${folderId === '__root' ? 'on' : ''}`} onClick={() => setFolderId('__root')}>
            <span>📄</span><span style={{ flex: 1 }}>未分类</span><span className="cnt">{countOf('__root')}</span>
          </div>
          {folders.map((f) => (
            <div
              key={f.id}
              className={`folder-item ${folderId === f.id ? 'on' : ''}`}
              onClick={() => setFolderId(f.id)}
              onDoubleClick={async () => {
                const n = prompt('重命名文件夹', f.name);
                if (n && n !== f.name) await renameFolder(f.id, n);
              }}
            >
              <span>📁</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span className="cnt">{countOf(f.id)}</span>
              <button
                className="iconbtn"
                onClick={async (e) => {
                  e.stopPropagation();
                  const n = countOf(f.id);
                  const ok = await ask({
                    title: '删除文件夹',
                    text: n ? `「${f.name}」下有 ${n} 个素材，会一并删除。继续？` : `确定删除「${f.name}」？`,
                    danger: true,
                  });
                  if (ok) { await deleteFolder(f.id); if (folderId === f.id) setFolderId(''); }
                }}
              >🗑</button>
            </div>
          ))}
        </div>

        {/* 网格 */}
        <div
          className="gridpane"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            if (e.dataTransfer.files?.length) void doUpload(e.dataTransfer.files);
          }}
          style={dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: -8 } : undefined}
        >
          {loading ? (
            <div className="muted small">加载中…</div>
          ) : byFolder.length === 0 ? (
            <Empty icon="🖼" text="这个文件夹还没有素材，拖文件到这里或点「上传素材」" />
          ) : (
            <div className="grid-assets">
              {byFolder.map((a) => (
                <div
                  key={a.id}
                  className={`asset-card ${selected.has(a.id) ? 'on' : ''}`}
                  onClick={() => setSelected((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                  onDoubleClick={() => setDetail(a)}
                >
                  <div className="thumb">
                    {a.kind === 'font' ? <span style={{ fontSize: 40 }}>Aa 字</span> : <img src={previewUrl(a)} alt={a.name} loading="lazy" />}
                  </div>
                  <div className="cap">
                    <div className="nm" title={a.name}>{a.name}</div>
                    <div className="sub">{formatBytes(a.size)} · {a.mime.split('/')[1]}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="row wrap">
          <span className="small muted">已选 {selected.size}</span>
          <button
            className="btn sm"
            onClick={async () => {
              const n = prompt('重命名', assets.find((a) => a.id === [...selected][0])?.name ?? '');
              if (!n) return;
              for (const id of selected) await renameAsset(id, n);
              setSelected(new Set());
            }}
          >重命名</button>
          <select
            className="select" style={{ width: 170 }}
            value=""
            onChange={(e) => {
              const v = e.target.value;
              void onMove([...selected], v === '__root' ? null : v || null);
              e.target.value = '';
            }}
          >
            <option value="">移动到…</option>
            <option value="__root">未分类</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button className="btn sm" onClick={() => setDetail(assets.find((a) => a.id === [...selected][0]) ?? null)}>详情</button>
          <button className="btn sm danger" onClick={() => void onDelete([...selected])}>删除</button>
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>取消</button>
        </div>
      )}

      {detail && (
        <AssetDetail
          asset={detail}
          folders={folders}
          onClose={() => setDetail(null)}
          onRename={async (n) => { await renameAsset(detail.id, n); setDetail({ ...detail, name: n }); }}
          onCrop={async (spec) => {
            try {
              const r = await api.cropAsset(detail.id, spec);
              await refresh();
              setDetail(r.asset);
              toast('裁切完成，已生成新素材', 'ok');
            } catch (e) { toast(`裁切失败：${(e as Error).message}`, 'err'); }
          }}
        />
      )}

      {showNewFolder && (
        <Modal
          title="新建文件夹"
          onClose={() => setShowNewFolder(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowNewFolder(false)}>取消</button>
              <button
                className="btn primary"
                onClick={async () => {
                  if (!newFolderName.trim()) return;
                  await addFolder(newFolderName.trim());
                  setNewFolderName(''); setShowNewFolder(false);
                  toast('已创建');
                }}
              >创建</button>
            </>
          }
        >
          <F label="文件夹名称">
            <input className="input" autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} />
          </F>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}

/* ---------------- 详情 / 裁切 ---------------- */

function AssetDetail({
  asset, folders, onClose, onRename, onCrop,
}: {
  asset: RemoteAssetDTO;
  folders: { id: string; name: string }[];
  onClose: () => void;
  onRename: (n: string) => void;
  onCrop: (spec: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(asset.name);
  const [cropMode, setCropMode] = useState<'original' | 'card' | 'custom'>('card');
  const [preset, setPreset] = useState('poker');
  const [w, setW] = useState(750);
  const [h, setH] = useState(1050);
  const [outName, setOutName] = useState(`${safeName(asset.name.replace(/\.[^.]+$/, ''))}-crop.webp`);
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState('');

  React.useEffect(() => {
    fetch(assetUrl(asset.url))
      .then((r) => r.blob())
      .then((b) => sha256(b))
      .then(setHash)
      .catch(() => setHash(asset.sha256));
  }, [asset.url, asset.sha256]);

  return (
    <Modal
      title="素材详情"
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div className="grid2">
        <div>
          <div className="icon-preview" style={{ minHeight: 240 }}>
            {asset.kind === 'font' ? <span style={{ fontSize: 36 }}>🔤 字体素材，请在字体库中预览并设定使用</span> : <img src={assetUrl(asset.url)} alt={asset.name} style={{ maxWidth: '100%', maxHeight: 300 }} />}
          </div>
          <div className="small faint mt8" style={{ wordBreak: 'break-all' }}>
            {asset.meta?.width ? `${asset.meta.width} × ${asset.meta.height}` : ''}
          </div>
        </div>
        <div>
          <F label="名称">
            <div className="row">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn sm" onClick={() => onRename(name)}>保存</button>
            </div>
          </F>
          <table className="tbl small">
            <tbody>
              <tr><td className="muted">类型</td><td>{asset.mime}</td></tr>
              <tr><td className="muted">大小</td><td>{formatBytes(asset.size)}</td></tr>
              <tr><td className="muted">尺寸</td><td>{asset.meta?.width ? `${asset.meta.width} × ${asset.meta.height}` : '—'}</td></tr>
              <tr><td className="muted">主色</td><td>{asset.meta?.dominant_color ?? '—'}</td></tr>
              <tr><td className="muted">来源</td><td>{asset.meta?.source === 'game-icons' ? `内置图标（${asset.meta.icon_id}）` : '上传'}</td></tr>
              <tr><td className="muted">文件夹</td><td>{folders.find((f) => f.id === asset.folder_id)?.name ?? '未分类'}</td></tr>
              <tr><td className="muted">SHA256</td><td className="mono" style={{ wordBreak: 'break-all' }}>{asset.sha256 || hash}</td></tr>
              <tr><td className="muted">创建</td><td>{formatDate(asset.created_at ?? '')}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {asset.kind === 'image' && asset.mime !== 'image/svg+xml' && (
        <div className="mt16">
          <h4 style={{ fontSize: 13, marginBottom: 8 }}>服务端裁切（生成新素材，不改动原图）</h4>
          <div className="row wrap">
            <Select
              value={cropMode}
              onChange={setCropMode}
              options={[
                { value: 'card', label: '按卡牌预设' },
                { value: 'custom', label: '自定义尺寸' },
                { value: 'original', label: '仅转 WebP' },
              ]}
            />
            {cropMode === 'card' && (
              <select className="select" style={{ width: 160 }} value={preset} onChange={(e) => {
                setPreset(e.target.value);
                const p = presetByKey(e.target.value);
                if (p) { setW(p.width); setH(p.height); }
              }}>
                {CARD_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.name} {p.width}×{p.height}</option>)}
              </select>
            )}
            {cropMode === 'custom' && (
              <>
                <input className="input num" type="number" value={w} onChange={(e) => setW(Number(e.target.value))} />
                <span>×</span>
                <input className="input num" type="number" value={h} onChange={(e) => setH(Number(e.target.value))} />
              </>
            )}
            <input className="input" style={{ width: 200 }} value={outName} onChange={(e) => setOutName(e.target.value)} />
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onCrop({
                  mode: cropMode, preset, width: w, height: h,
                  focus_x: 0.5, focus_y: 0.5, zoom: 1,
                  name: outName.endsWith('.webp') ? outName : `${outName}.webp`,
                });
                setBusy(false);
              }}
            >{busy ? '处理中…' : '裁切'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
