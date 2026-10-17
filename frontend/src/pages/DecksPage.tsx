import React, { useState } from 'react';
import { useProject } from '../state/store';
import { useToast, useConfirm, Modal, Select, Empty, Field as F, NumberInput } from '../components/ui';
import type { Deck, Field, FieldType, Layout } from '../lib/types';
import { CARD_PRESETS, presetByKey, matchPreset } from '../lib/presets';
import { move, uid } from '../lib/utils';

const TYPE_LABEL: Record<FieldType, string> = {
  text: '文本', number: '数字', image: '图片', select: '下拉选择', color: '颜色', boolean: '是/否',
};

export default function DecksPage() {
  const { content, update } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const decks = content.decks ?? [];
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '');
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  const [showSize, setShowSize] = useState(false);
  const [showCopy, setShowCopy] = useState(false);

  const patch = (fn: (d: Deck) => void, label = '编辑牌组') =>
    update((c) => { const d = c.decks.find((x) => x.id === deck?.id); if (d) fn(d); }, label);

  const addDeck = () => {
    const id = uid();
    update((c) => {
      c.decks.push({
        id, name: `牌组 ${c.decks.length + 1}`,
        fields: [
          { id: 'name', name: '名称', type: 'text', showInTable: true },
          { id: 'count', name: '数量', type: 'number', showInTable: true },
        ],
        cards: [], frontLayout: null, backLayout: null, useSharedBack: true,
      });
    }, '新增牌组');
    setDeckId(id);
  };

  const delDeck = async (id: string, name: string) => {
    const ok = await ask({ title: '删除牌组', text: `确定删除「${name}」？该牌组下的 ${decks.find((d) => d.id === id)?.cards.length ?? 0} 张卡牌也会一并删除。`, danger: true });
    if (!ok) return;
    await update((c) => { c.decks = c.decks.filter((d) => d.id !== id); }, '删除牌组');
    setDeckId('');
    toast('已删除');
  };

  const applyPreset = (key: string) => {
    const p = presetByKey(key);
    if (!p || !deck) return;
    patch((d) => {
      for (const side of ['frontLayout', 'backLayout'] as const) {
        const l = d[side];
        if (!l) continue;
        l.width = p.width; l.height = p.height; l.widthMm = p.widthMm; l.heightMm = p.heightMm;
      }
    }, '修改卡牌尺寸');
    setShowSize(false);
    toast(`已应用「${p.name}」`);
  };

  const copyLayoutTo = (targetIds: string[], side: 'front' | 'both') => {
    if (!deck) return;
    const srcF = deck.frontLayout, srcB = deck.backLayout;
    update((c) => {
      for (const tid of targetIds) {
        const t = c.decks.find((d) => d.id === tid);
        if (!t) continue;
        if (srcF) t.frontLayout = JSON.parse(JSON.stringify(srcF)) as Layout;
        if (side === 'both' && srcB) t.backLayout = JSON.parse(JSON.stringify(srcB)) as Layout;
      }
    }, '复制版式');
    setShowCopy(false);
    toast(`已复制到 ${targetIds.length} 个牌组`);
  };

  if (!deck) {
    return (
      <div>
        <Empty icon="🎴" text="还没有牌组" action={<button className="btn primary" onClick={addDeck}>+ 新建牌组</button>} />
        {confirmNode}
      </div>
    );
  }

  const size = deck.frontLayout ? { w: deck.frontLayout.width, h: deck.frontLayout.height } : null;
  const matched = size ? matchPreset(size.w, size.h) : undefined;

  return (
    <div className="grid2" style={{ gridTemplateColumns: '300px 1fr', alignItems: 'start' }}>
      {/* 牌组列表 */}
      <div className="card">
        <div className="hd">
          <span style={{ flex: 1 }}>牌组</span>
          <button className="btn sm primary" onClick={addDeck}>+ 新建</button>
        </div>
        <div className="bd" style={{ padding: 8 }}>
          {decks.map((d) => (
            <div
              key={d.id}
              className={`folder-item ${d.id === deck.id ? 'on' : ''}`}
              onClick={() => setDeckId(d.id)}
              onDoubleClick={async () => {
                const n = prompt('重命名牌组', d.name);
                if (n && n !== d.name) {
                  await update((c) => { const t = c.decks.find((x) => x.id === d.id); if (t) t.name = n; }, '重命名牌组');
                }
              }}
            >
              <span>🎴</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              <span className="cnt">{d.cards.length}</span>
              <button
                className="iconbtn"
                onClick={(e) => { e.stopPropagation(); void delDeck(d.id, d.name); }}
                title="删除"
              >🗑</button>
            </div>
          ))}
        </div>
      </div>

      {/* 字段管理 */}
      <div>
        <div className="card">
          <div className="hd">
            <span style={{ flex: 1 }}>{deck.name} · 字段</span>
            <span className="small muted">
              {size ? `${size.w}×${size.h}px @300DPI${matched ? ` · ${matched.name}` : ''}` : '未设置版式'}
            </span>
            <button className="btn sm" onClick={() => setShowSize(true)}>卡牌尺寸</button>
            <button className="btn sm" onClick={() => setShowCopy(true)}>复制版式到…</button>
          </div>
          <div className="bd">
            <FieldsEditor deck={deck} onChange={(fn) => patch(fn, '编辑字段')} />
          </div>
        </div>

        <div className="card mt16">
          <div className="hd">提示</div>
          <div className="bd small muted" style={{ lineHeight: 1.8 }}>
            <div>· 字段 id 一旦生成不要随意改动，版式里 <span className="mono">{'{id}'}</span> 绑定依赖它。</div>
            <div>· 「数量」字段用于导出时把一行展开成多张相同卡牌。</div>
            <div>· 不想出现在表格里的字段（比如长描述）可以取消「显示在表格」。</div>
          </div>
        </div>
      </div>

      {showSize && (
        <Modal title="卡牌尺寸" onClose={() => setShowSize(false)}>
          <div className="small muted" style={{ marginBottom: 10 }}>
            当前：{size ? `${size.w} × ${size.h} px` : '未设置'}
            {matched ? `（${matched.name}）` : ''}
          </div>
          <div className="grid2">
            {CARD_PRESETS.map((p) => (
              <button key={p.key} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => applyPreset(p.key)}>
                <span>{p.name}</span>
                <span className="small faint">{p.width}×{p.height} · {p.widthMm}×{p.heightMm}mm</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {showCopy && (
        <CopyLayoutModal
          decks={decks.filter((d) => d.id !== deck.id)}
          onClose={() => setShowCopy(false)}
          onOk={copyLayoutTo}
        />
      )}
      {confirmNode}
    </div>
  );
}

/* ---------------- 字段编辑器 ---------------- */

function FieldsEditor({ deck, onChange }: { deck: Deck; onChange: (fn: (d: Deck) => void) => void }) {
  const [editing, setEditing] = useState<Field | null>(null);
  const fields = deck.fields ?? [];

  const addField = () => {
    const f: Field = { id: uid().slice(0, 8), name: '新字段', type: 'text', showInTable: true };
    onChange((d) => { d.fields.push(f); });
  };

  const removeField = (id: string) => {
    if (id === 'name' || id === 'count') return;
    onChange((d) => { d.fields = d.fields.filter((f) => f.id !== id); });
  };

  const reorder = (i: number, dir: -1 | 1) => {
    onChange((d) => { d.fields = move(d.fields, i, i + dir); });
  };

  return (
    <>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>字段名</th>
            <th>类型</th>
            <th style={{ width: 90 }}>表格</th>
            <th style={{ width: 130 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.id}>
              <td className="faint small">{i + 1}</td>
              <td>
                <span style={{ cursor: 'pointer' }} onClick={() => setEditing(f)}>{f.name}</span>
                <div className="small faint mono">{f.id}</div>
              </td>
              <td>{TYPE_LABEL[f.type]}{f.type === 'select' && <span className="small faint"> （{(f.options ?? []).length} 项）</span>}</td>
              <td>
                <input
                  type="checkbox" checked={f.showInTable !== false}
                  onChange={(e) => onChange((d) => { const t = d.fields.find((x) => x.id === f.id); if (t) t.showInTable = e.target.checked; })}
                />
              </td>
              <td className="nowrap">
                <button className="iconbtn" onClick={() => reorder(i, -1)} disabled={i === 0}>↑</button>
                <button className="iconbtn" onClick={() => reorder(i, 1)} disabled={i === fields.length - 1}>↓</button>
                <button className="iconbtn" onClick={() => setEditing(f)}>✎</button>
                <button className="iconbtn" onClick={() => removeField(f.id)} disabled={f.id === 'name' || f.id === 'count'}>🗑</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn sm mt8" onClick={addField}>+ 新增字段</button>

      {editing && (
        <FieldModal
          field={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange((d) => {
              const i = d.fields.findIndex((x) => x.id === next.id);
              if (i >= 0) d.fields[i] = next; else d.fields.push(next);
            });
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function FieldModal({
  field, onClose, onSave,
}: {
  field: Field; onClose: () => void; onSave: (f: Field) => void;
}) {
  const [f, setF] = useState<Field>({ ...field });
  const [optText, setOptText] = useState((field.options ?? []).join('\n'));

  const save = () => {
    const next: Field = { ...f, name: f.name.trim() || '未命名字段' };
    if (next.type === 'select') {
      next.options = optText.split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      delete next.options;
    }
    onSave(next);
  };

  return (
    <Modal
      title="编辑字段"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={save}>保存</button></>}
    >
      <F label="字段名称">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </F>
      <F label="字段 id（版式绑定用，生成后不建议修改）">
        <input className="input mono" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} />
      </F>
      <F label="类型">
        <Select
          value={f.type}
          onChange={(v) => setF({ ...f, type: v })}
          options={(Object.keys(TYPE_LABEL) as FieldType[]).map((k) => ({ value: k, label: TYPE_LABEL[k] }))}
        />
      </F>
      {f.type === 'select' && (
        <F label="选项（每行一个）">
          <textarea className="input" rows={6} value={optText} onChange={(e) => setOptText(e.target.value)} />
        </F>
      )}
      {f.type === 'number' && (
        <F label="默认值">
          <NumberInput value={Number(f.defaultValue ?? 0)} onChange={(v) => setF({ ...f, defaultValue: v })} />
        </F>
      )}
      {(f.type === 'text' || f.type === 'select') && (
        <F label="默认值">
          <input className="input" value={String(f.defaultValue ?? '')} onChange={(e) => setF({ ...f, defaultValue: e.target.value })} />
        </F>
      )}
      <label className="row small">
        <input type="checkbox" checked={f.showInTable !== false} onChange={(e) => setF({ ...f, showInTable: e.target.checked })} />
        显示在卡牌数据表
      </label>
    </Modal>
  );
}

function CopyLayoutModal({
  decks, onClose, onOk,
}: {
  decks: Deck[]; onClose: () => void; onOk: (ids: string[], side: 'front' | 'both') => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  const [side, setSide] = useState<'front' | 'both'>('both');
  return (
    <Modal
      title="复制版式到其他牌组"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!ids.length} onClick={() => onOk(ids, side)}>复制</button>
        </>
      }
    >
      {decks.length === 0 ? (
        <Empty text="没有其他牌组" />
      ) : (
        <>
          {decks.map((d) => (
            <label key={d.id} className="row" style={{ padding: '4px 0' }}>
              <input
                type="checkbox"
                checked={ids.includes(d.id)}
                onChange={(e) => setIds(e.target.checked ? [...ids, d.id] : ids.filter((x) => x !== d.id))}
              />
              {d.name}
            </label>
          ))}
          <div className="mt16">
            <F label="复制范围">
              <Select
                value={side} onChange={setSide}
                options={[{ value: 'both', label: '正面 + 背面' }, { value: 'front', label: '仅正面' }]}
              />
            </F>
          </div>
          <div className="small faint">目标牌组的现有版式会被覆盖。</div>
        </>
      )}
    </Modal>
  );
}
