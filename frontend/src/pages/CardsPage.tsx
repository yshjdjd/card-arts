import React, { useMemo, useRef, useState } from 'react';
import { useProject, useAssets } from '../state/store';
import { useToast, useConfirm, Modal, Select, Empty } from '../components/ui';
import { AssetPicker } from '../components/AssetPicker';
import { previewUrl } from '../api/uploader';
import type { Card, Deck, Field } from '../lib/types';
import { exportCSV, exportXLSX, parseCSV, readXLSX, guessFieldIds, rowsToCards } from '../lib/table';
import { safeName } from '../lib/utils';

const newId = (): string =>
  (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

export default function CardsPage() {
  const { content, update } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const decks = content.decks ?? [];
  const [deckId, setDeckId] = useState<string>('');
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];

  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [importData, setImportData] = useState<{ header: string[]; rows: string[][]; file: string } | null>(null);
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
  const fileRef = useRef<HTMLInputElement>(null);

  const fields = useMemo(() => (deck?.fields ?? []).filter((f) => f.showInTable !== false), [deck]);
  const cards = deck?.cards ?? [];

  const filtered = useMemo(() => {
    if (!q.trim()) return cards;
    const k = q.trim().toLowerCase();
    return cards.filter((c) => fields.some((f) => String(c.values?.[f.id] ?? '').toLowerCase().includes(k)));
  }, [cards, fields, q]);

  const totalCopies = useMemo(
    () => cards.reduce((n, c) => n + (Number(c.values?.count ?? 1) || 1), 0),
    [cards],
  );

  const patchDeck = async (fn: (d: Deck) => void) => {
    if (!deck) return;
    await update((c) => {
      const d = c.decks.find((x) => x.id === deck.id);
      if (d) fn(d);
    }, '编辑卡牌数据');
  };

  const setCell = async (cardId: string, fieldId: string, value: unknown) =>
    patchDeck((d) => {
      const c = d.cards.find((x) => x.id === cardId);
      if (c) c.values[fieldId] = value;
    });

  const addCard = () =>
    patchDeck((d) => {
      const values: Record<string, unknown> = {};
      for (const f of d.fields) {
        values[f.id] =
          f.id === 'count' ? 1
            : f.defaultValue ?? (f.type === 'number' ? 0 : f.type === 'select' ? (f.options?.[0] ?? '') : '');
      }
      d.cards.push({ id: newId(), values });
    });

  const delCards = async (ids: string[]) => {
    const ok = await ask({ title: '删除卡牌', text: `确定删除选中的 ${ids.length} 张卡牌？`, danger: true });
    if (!ok) return;
    await patchDeck((d) => { d.cards = d.cards.filter((c) => !ids.includes(c.id)); });
    setPicked(new Set());
    toast('已删除');
  };

  const dupCards = async (ids: string[]) => {
    await patchDeck((d) => {
      d.cards.push(...d.cards.filter((c) => ids.includes(c.id)).map((c) => ({ id: newId(), values: { ...c.values } })));
    });
    toast(`已复制 ${ids.length} 张`);
  };

  const onImportFile = async (f: File) => {
    try {
      let data: string[][] = [];
      if (f.name.toLowerCase().endsWith('.csv')) data = parseCSV(await f.text());
      else if (/\.(xlsx|xls)$/i.test(f.name)) {
        const sheets = await readXLSX(f);
        data = Object.values(sheets)[0] ?? [];
      } else { toast('仅支持 CSV / XLSX', 'err'); return; }
      if (!data.length) { toast('文件为空', 'err'); return; }
      setImportData({ header: data[0], rows: data.slice(1), file: f.name });
      setShowImport(true);
    } catch (e) {
      toast(`读取失败：${(e as Error).message}`, 'err');
    }
  };

  const doImport = async () => {
    if (!deck || !importData) return;
    const ids = guessFieldIds(importData.header, deck.fields);
    const next = rowsToCards([importData.header, ...importData.rows], ids, deck.fields, importMode, deck.cards);
    await patchDeck((d) => { d.cards = next; });
    setShowImport(false);
    setImportData(null);
    toast(`已导入 ${next.length} 行`, 'ok');
  };

  const toggle = (id: string) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const allOn = filtered.length > 0 && filtered.every((c) => picked.has(c.id));

  if (!deck) return <Empty icon="🎴" text="还没有牌组，请先在「牌组与字段」中创建" />;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 200 }} value={deck.id} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input className="input" style={{ width: 220 }} placeholder="搜索卡牌…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small muted">共 {cards.length} 条 · 展开后 {totalCopies} 张</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => fileRef.current?.click()}>导入 CSV/XLSX</button>
        <button className="btn" onClick={() => exportCSV(deck, `${safeName(deck.name)}.csv`)}>导出 CSV</button>
        <button className="btn" onClick={() => void exportXLSX(decks, `${safeName(deck.name)}.xlsx`)}>导出 XLSX</button>
        <button className="btn primary" onClick={() => void addCard()}>+ 新增卡牌</button>
        <input
          ref={fileRef} type="file" accept=".csv,.xlsx,.xls" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }}
        />
      </div>

      <div className="card">
        <div style={{ maxHeight: 'calc(100vh - 220px)', overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <Empty icon="🗂" text="还没有卡牌数据，点右上角新增或导入 CSV" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 42 }}>
                    <input
                      type="checkbox" checked={allOn}
                      onChange={(e) => setPicked(e.target.checked ? new Set(filtered.map((c) => c.id)) : new Set())}
                    />
                  </th>
                  {fields.map((f) => <th key={f.id} title={f.type}>{f.name}</th>)}
                  <th style={{ width: 90 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /></td>
                    {fields.map((f) => (
                      <td key={f.id} className="cell">
                        <CellInput field={f} value={c.values?.[f.id]} onChange={(v) => void setCell(c.id, f.id, v)} />
                      </td>
                    ))}
                    <td className="nowrap">
                      <button className="iconbtn" title="复制" onClick={() => void dupCards([c.id])}>⧉</button>
                      <button className="iconbtn" title="删除" onClick={() => void delCards([c.id])}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {picked.size > 0 && (
        <div className="row mt8">
          <span className="small muted">已选 {picked.size} 张</span>
          <button className="btn sm" onClick={() => void dupCards([...picked])}>批量复制</button>
          <button className="btn sm danger" onClick={() => void delCards([...picked])}>批量删除</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>取消选择</button>
        </div>
      )}

      {showImport && importData && deck && (
        <Modal
          title={`导入到「${deck.name}」`}
          wide
          onClose={() => setShowImport(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowImport(false)}>取消</button>
              <button className="btn primary" onClick={() => void doImport()}>导入 {importData.rows.length} 行</button>
            </>
          }
        >
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="small muted">来自 {importData.file}</span>
            <span style={{ flex: 1 }} />
            <Select
              value={importMode} onChange={setImportMode}
              options={[{ value: 'append', label: '追加到现有数据' }, { value: 'replace', label: '替换现有数据' }]}
            />
          </div>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  {importData.header.map((h, i) => {
                    const fid = guessFieldIds(importData.header, deck.fields)[i];
                    return (
                      <th key={i}>
                        {h}
                        <div className={`small ${fid ? '' : 'faint'}`}>
                          {fid ? `→ ${deck.fields.find((f) => f.id === fid)?.name}` : '（忽略）'}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {importData.rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>{importData.header.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small faint mt8">表头按「字段 id → 字段名称」自动匹配；以上仅预览前 8 行。</div>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}

function CellInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const [txt, setTxt] = useState(String(value ?? ''));
  const [pick, setPick] = useState(false);
  const { assets } = useAssets();
  React.useEffect(() => setTxt(String(value ?? '')), [value]);

  // 图片字段：存的是素材 id，必须能直接从素材库挑 / 直接上传，
  // 否则用户只能手抄 id——之前就是落到了下面的纯文本框。
  if (field.type === 'image') {
    const hit = assets.find((a) => a.id === txt);
    return (
      <>
        <button
          className="cell-img"
          onClick={() => setPick(true)}
          title={txt ? `更换图片（当前 ${hit?.name ?? txt}）` : '选择图片'}
        >
          {hit ? <img src={previewUrl(hit)} alt={hit.name} /> : <span>＋ 选图</span>}
        </button>
        {txt && <button className="btn ghost sm" onClick={() => onChange('')} title="清除图片">✕</button>}
        {pick && (
          <AssetPicker
            kind="image" value={txt}
            onPick={(id) => { onChange(id); setPick(false); }}
            onClose={() => setPick(false)}
          />
        )}
      </>
    );
  }

  if (field.type === 'select') {
    return (
      <select className="select" style={{ border: 0, background: 'transparent' }} value={txt} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return <input type="checkbox" checked={txt === 'true'} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === 'color') {
    return <input type="color" value={txt || '#000000'} onChange={(e) => onChange(e.target.value)} style={{ width: 44, height: 28, border: 0, background: 'transparent' }} />;
  }
  return (
    <input
      value={txt}
      inputMode={field.type === 'number' ? 'decimal' : 'text'}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => onChange(field.type === 'number' ? (txt === '' ? '' : Number(txt)) : txt)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}
