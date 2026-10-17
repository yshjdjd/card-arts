import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ColorInput } from '../../components/ui';
import { api } from '../../api/client';
import { useToast } from '../../components/ui';
import type { IconItem } from '../../lib/types';

/** 版式编辑器里选一个内置图标 */
export default function IconPicker({
  onClose, onPick,
}: {
  onClose: () => void;
  onPick: (iconId: string) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<IconItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [color, setColor] = useState('#111827');
  const [stats, setStats] = useState<{ loaded: boolean; count: number } | null>(null);

  const colorParam = useMemo(() => color.replace('#', ''), [color]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.searchIcons(q, { limit: 120, color: colorParam })
        .then((r) => { if (alive) { setItems(r.items); setTotal(r.total); } })
        .catch(() => { if (alive) toast('图标库不可用（后端未启动？）', 'err'); })
        .finally(() => { if (alive) setLoading(false); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, colorParam, toast]);

  useEffect(() => {
    api.iconStats().then(setStats).catch(() => setStats({ loaded: false, count: 0 }));
  }, []);

  return (
    <Modal
      title={`选择内置图标${stats?.loaded ? ` · 共 ${stats.count} 个` : ''}`}
      wide
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="input" style={{ maxWidth: 260 }} autoFocus
          placeholder="搜索图标名或作者…" value={q} onChange={(e) => setQ(e.target.value)}
        />
        <span className="small muted">预览颜色</span>
        <div style={{ width: 260 }}><ColorInput value={color} onChange={setColor} /></div>
        <span style={{ flex: 1 }} />
        <span className="small faint">{loading ? '搜索中…' : `${total} 个结果`}</span>
      </div>

      <div className="icon-grid" style={{ maxHeight: 420, overflow: 'auto' }}>
        {items.map((it) => (
          <div key={it.id} className="icon-cell" title={`${it.name} — ${it.author}`} onClick={() => onPick(it.id)}>
            <img src={api.iconSvgUrl(it.id, colorParam)} alt={it.name} loading="lazy" />
          </div>
        ))}
        {!loading && items.length === 0 && (
          <div className="small faint" style={{ gridColumn: '1/-1', padding: 20, textAlign: 'center' }}>
            没有匹配的图标{stats && !stats.loaded ? '（图标库未加载）' : ''}
          </div>
        )}
      </div>
    </Modal>
  );
}
