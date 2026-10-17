import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAssets, useProject } from '../state/store';
import { useToast, Modal, ColorInput, Select, Empty, Field as F } from '../components/ui';
import { api } from '../api/client';
import { assetUrl } from '../api/client';
import type { IconItem } from '../lib/types';
import { safeName } from '../lib/utils';
import { previewUrl } from '../api/uploader';

const PAGE = 120;

export default function IconLibraryPage() {
  const toast = useToast();
  const { assets, folders, addFolder, refresh, remoteId: ensureRemote } = useAssets();
  const { project } = useProject();
  const [remoteProjectId, setRemoteProjectId] = useState('');

  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('');
  const [authors, setAuthors] = useState<{ author: string; count: number }[]>([]);
  const [items, setItems] = useState<IconItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<{ loaded: boolean; count: number; license: string } | null>(null);

  const [color, setColor] = useState('#111827');
  const [bg, setBg] = useState('#ffffff');
  const [cellSize, setCellSize] = useState<'S' | 'M' | 'L'>('M');

  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // iconId -> 默认名
  const [preview, setPreview] = useState<IconItem | null>(null);
  const [showImport, setShowImport] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const colorParam = useMemo(() => color.replace('#', ''), [color]);
  const cellPx = cellSize === 'S' ? 72 : cellSize === 'M' ? 96 : 128;

  useEffect(() => {
    api.iconStats().then(setStats).catch(() => setStats(null));
    api.iconAuthors().then((r) => setAuthors(r.items ?? [])).catch(() => setAuthors([]));
  }, []);

  // 素材要挂在服务端项目下；本地项目第一次用到素材库时会先在服务端建好
  useEffect(() => {
    ensureRemote().then(setRemoteProjectId).catch(() => setRemoteProjectId(''));
  }, [ensureRemote, project?.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.searchIcons(q, { limit: PAGE, offset, author: author || undefined, color: colorParam })
        .then((r) => { if (alive) { setItems(r.items); setTotal(r.total); } })
        .catch(() => { if (alive) { setItems([]); toast('图标库不可用，请先启动后端', 'err'); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, author, offset, colorParam, toast]);

  useEffect(() => { setOffset(0); }, [q, author]);
  useEffect(() => { gridRef.current?.scrollTo({ top: 0 }); }, [offset]);

  const toggle = (it: IconItem) =>
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(it.id)) n.delete(it.id);
      else n.set(it.id, safeName(it.name));
      return n;
    });

  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* 顶部工具条 */}
      <div className="row wrap">
        <input
          className="input" style={{ width: 240 }}
          placeholder="搜索图标名 / 作者…" value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ width: 170 }} value={author} onChange={(e) => setAuthor(e.target.value)}>
          <option value="">全部作者</option>
          {authors.slice(0, 60).map((a) => (
            <option key={a.author} value={a.author}>{a.author}（{a.count}）</option>
          ))}
        </select>
        <span className="small muted">图标色</span>
        <div style={{ width: 250 }}><ColorInput value={color} onChange={setColor} /></div>
        <span className="small muted">网格</span>
        <Select
          value={cellSize}
          onChange={setCellSize}
          options={[{ value: 'S', label: '小' }, { value: 'M', label: '中' }, { value: 'L', label: '大' }]}
        />
        <span style={{ flex: 1 }} />
        <span className="small faint">
          {stats?.loaded ? `共 ${stats.count} 个 · ${stats.license ?? ''}` : '图标库未加载'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 12, flex: 1, minHeight: 0 }}>
        {/* 图标网格 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="hd">
            <span style={{ flex: 1 }}>
              {loading ? '搜索中…' : `${total} 个结果`}
              {selected.size > 0 && <span className="tag" style={{ marginLeft: 8 }}>已选 {selected.size}</span>}
            </span>
            <button className="btn sm" onClick={() => setSelected(new Map())} disabled={!selected.size}>清空选择</button>
            <button
              className="btn sm"
              onClick={() => {
                const all = new Map(selected);
                items.forEach((it) => { if (!all.has(it.id)) all.set(it.id, safeName(it.name)); });
                setSelected(all);
              }}
            >全选本页</button>
            <button className="btn sm primary" disabled={!selected.size} onClick={() => setShowImport(true)}>
              添加到素材库（{selected.size}）
            </button>
          </div>
          <div ref={gridRef} style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            {items.length === 0 && !loading ? (
              <Empty icon="✨" text="没有匹配的图标" />
            ) : (
              <div
                className="icon-grid"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cellPx}px, 1fr))` }}
              >
                {items.map((it) => (
                  <div
                    key={it.id}
                    className={`icon-cell ${selected.has(it.id) ? 'on' : ''}`}
                    style={{ aspectRatio: '1', background: bg }}
                    title={`${it.name} — ${it.author}`}
                    onClick={() => toggle(it)}
                    onMouseEnter={() => setPreview(it)}
                  >
                    <img src={api.iconSvgUrl(it.id, colorParam)} alt={it.name} loading="lazy" />
                    <span className="ck">{selected.has(it.id) ? '✓' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ft" style={{ alignItems: 'center' }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</button>
            <span className="small muted">{page} / {pageCount}</span>
            <button className="btn sm" disabled={page >= pageCount} onClick={() => setOffset(offset + PAGE)}>下一页</button>
            <span style={{ flex: 1 }} />
            <span className="small faint">点击图标可多选，鼠标悬停查看大图</span>
          </div>
        </div>

        {/* 预览面板 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="hd">预览</div>
          <div style={{ padding: 12, overflow: 'auto' }}>
            {!preview ? (
              <div className="small faint">把鼠标移到图标上查看详情</div>
            ) : (
              <>
                <div className="icon-preview" style={{ background: bg }}>
                  <img src={api.iconSvgUrl(preview.id, colorParam)} alt={preview.name} style={{ width: 160, height: 160 }} />
                </div>
                <div className="mt16">
                  <div style={{ fontWeight: 600 }}>{preview.name}</div>
                  <div className="small muted">作者：{preview.author}</div>
                  <div className="small faint mono" style={{ wordBreak: 'break-all' }}>{preview.id}</div>
                </div>
                <div className="mt16">
                  <div className="small muted" style={{ marginBottom: 6 }}>不同尺寸</div>
                  <div className="row">
                    {[24, 48, 96].map((s) => (
                      <div key={s} style={{ background: bg, border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                        <img src={api.iconSvgUrl(preview.id, colorParam, s)} style={{ width: s, height: s }} alt="" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt16">
                  <F label="预览底色">
                    <ColorInput value={bg} onChange={setBg} />
                  </F>
                </div>
                <div className="row">
                  <button
                    className="btn sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(preview.id);
                      toast('已复制图标 id');
                    }}
                  >复制 id</button>
                  <button
                    className="btn sm primary"
                    onClick={() => {
                      setSelected(new Map([[preview.id, safeName(preview.name)]]));
                      setShowImport(true);
                    }}
                  >添加到素材库</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showImport && remoteProjectId && (
        <ImportIconsModal
          projectId={remoteProjectId}
          icons={[...selected.entries()].map(([id, name]) => ({
            id, name,
            display: items.find((x) => x.id === id)?.name ?? id.split('/').pop() ?? id,
          }))}
          folderOptions={folders.map((f) => ({ value: f.id, label: f.name }))}
          color={color}
          onClose={() => setShowImport(false)}
          onCreateFolder={async (name) => (await addFolder(name)).id}
          onDone={async (n) => {
            setShowImport(false);
            setSelected(new Map());
            await refresh();
            toast(`已添加 ${n} 个图标到素材库`, 'ok');
          }}
        />
      )}
    </div>
  );
}

/* ---------------- 加入自建素材库 ---------------- */

interface PickedIcon { id: string; name: string; display: string }

function ImportIconsModal({
  projectId, icons, folderOptions, color: defaultColor,
  onClose, onCreateFolder, onDone,
}: {
  projectId: string;
  icons: PickedIcon[];
  folderOptions: { value: string; label: string }[];
  color: string;
  onClose: () => void;
  onCreateFolder: (name: string) => Promise<string>;
  onDone: (n: number) => void;
}) {
  const toast = useToast();
  const [folderId, setFolderId] = useState<string>(folderOptions[0]?.value ?? '');
  const [newFolder, setNewFolder] = useState('');
  const [names, setNames] = useState<Record<string, string>>(
    () => Object.fromEntries(icons.map((i) => [i.id, `${i.name}.svg`])),
  );
  const [template, setTemplate] = useState('{name}');
  const [color, setColor] = useState(defaultColor);
  const [conflict, setConflict] = useState<'rename' | 'skip' | 'replace'>('rename');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: icons.length });

  const applyTemplate = () => {
    setNames(
      Object.fromEntries(
        icons.map((i, idx) => [
          i.id,
          `${safeName(
            template
              .replace('{name}', i.display)
              .replace('{author}', i.id.split('/')[0] ?? '')
              .replace('{index}', String(idx + 1)),
          )}.svg`,
        ]),
      ),
    );
  };

  const doImport = async () => {
    setBusy(true);
    let target = folderId;
    try {
      if (newFolder.trim()) target = await onCreateFolder(newFolder.trim());
    } catch {
      toast('创建文件夹失败，将放入根目录', 'err');
    }

    let ok = 0;
    for (let i = 0; i < icons.length; i++) {
      const it = icons[i];
      try {
        await api.importIcon({
          project_id: projectId,
          icon_id: it.id,
          name: names[it.id] || `${safeName(it.display)}.svg`,
          folder_id: target || null,
          color: color || undefined,
          on_conflict: conflict,
        });
        ok++;
      } catch (e) {
        toast(`${it.display}：${(e as Error).message}`, 'err');
      }
      setProgress({ done: i + 1, total: icons.length });
    }
    setBusy(false);
    onDone(ok);
  };

  return (
    <Modal
      title={`把 ${icons.length} 个图标加入素材库`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={() => void doImport()} disabled={busy}>
            {busy ? `导入中 ${progress.done}/${progress.total}` : '确认添加'}
          </button>
        </>
      }
    >
      <div className="grid2">
        <div>
          <F label="目标文件夹">
            <select className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">（根目录）</option>
              {folderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </F>
          <F label="或新建文件夹">
            <input className="input" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="例如：状态图标" />
          </F>
        </div>
        <div>
          <F label="名称模板（可批量重命名）">
            <div className="row">
              <input className="input" value={template} onChange={(e) => setTemplate(e.target.value)} />
              <button className="btn sm" onClick={applyTemplate}>应用</button>
            </div>
            <div className="small faint mt8">支持 {'{name}'} / {'{author}'} / {'{index}'}</div>
          </F>
          <F label="图标颜色（会烘进 SVG）">
            <ColorInput value={color} onChange={setColor} />
          </F>
          <F label="重名处理">
            <Select
              value={conflict}
              onChange={setConflict}
              options={[
                { value: 'rename', label: '自动加序号' },
                { value: 'skip', label: '跳过' },
                { value: 'replace', label: '覆盖同名' },
              ]}
            />
          </F>
        </div>
      </div>

      <div className="mt16">
        <div className="small muted" style={{ marginBottom: 6 }}>逐个重命名（可直接编辑）</div>
        <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 46 }}>预览</th>
                <th>原始名</th>
                <th>保存为</th>
              </tr>
            </thead>
            <tbody>
              {icons.map((i) => (
                <tr key={i.id}>
                  <td>
                    <img src={api.iconSvgUrl(i.id, color.replace('#', ''), 28)} style={{ width: 28, height: 28 }} alt="" />
                  </td>
                  <td className="small muted">{i.display}</td>
                  <td className="cell">
                    <input
                      value={names[i.id] ?? ''}
                      onChange={(e) => setNames((s) => ({ ...s, [i.id]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {folderOptions.length === 0 && !newFolder && (
        <div className="small faint mt8">当前项目还没有素材文件夹，可以直接在上方新建一个。</div>
      )}
    </Modal>
  );
}

void assetUrl; void previewUrl;
