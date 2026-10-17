import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isHexColor } from '../lib/utils';

/* ---------------- Toast ---------------- */

interface ToastItem { id: number; text: string; kind: 'info' | 'ok' | 'err' }

const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((i) => (
          <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Modal ---------------- */

export function Modal({
  title, children, onClose, footer, wide, xwide,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
  xwide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''}`}>
        <div className="mhd">
          <h3 style={{ flex: 1 }}>{title}</h3>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="mbd">{children}</div>
        {footer && <div className="mft">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  title, text, danger, onOk, onCancel,
}: {
  title: string; text: React.ReactNode; danger?: boolean;
  onOk: () => void; onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>取消</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onOk}>确定</button>
        </>
      }
    >
      <div style={{ lineHeight: 1.7 }}>{text}</div>
    </Modal>
  );
}

/** useConfirm：返回 [节点, 询问函数] */
export function useConfirm(): [React.ReactNode, (o: { title: string; text: React.ReactNode; danger?: boolean }) => Promise<boolean>] {
  const [st, setSt] = useState<{ title: string; text: React.ReactNode; danger?: boolean; resolve?: (b: boolean) => void } | null>(null);
  const ask = useCallback(
    (o: { title: string; text: React.ReactNode; danger?: boolean }) =>
      new Promise<boolean>((resolve) => setSt({ ...o, resolve })),
    [],
  );
  const node = st ? (
    <Confirm
      title={st.title}
      text={st.text}
      danger={st.danger}
      onCancel={() => { st.resolve?.(false); setSt(null); }}
      onOk={() => { st.resolve?.(true); setSt(null); }}
    />
  ) : null;
  return [node, ask];
}

/* ---------------- 表单控件 ---------------- */

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label className="lbl">{label}</label>
      {children}
      {hint && <div className="small faint mt8">{hint}</div>}
    </div>
  );
}

export function NumberInput({
  value, onChange, min, max, step = 1, suffix,
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  const [txt, setTxt] = useState(String(value ?? 0));
  useEffect(() => { setTxt(String(value ?? 0)); }, [value]);
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (Number.isNaN(n)) { setTxt(String(value ?? 0)); return; }
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onChange(v);
    setTxt(String(v));
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <input
        className="input num"
        value={txt}
        inputMode="decimal"
        onChange={(e) => setTxt(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
      />
      {suffix && <span className="small muted">{suffix}</span>}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [txt, setTxt] = useState(value ?? '#000000');
  useEffect(() => { setTxt(value ?? '#000000'); }, [value]);
  const swatches = ['#ffffff', '#1f2937', '#000000', '#dc2626', '#f59e0b', '#16a34a', '#2563eb', '#7c3aed', '#e5e7eb', 'transparent'];
  return (
    <div className="row wrap">
      <input
        type="color"
        value={isHexColor(txt) ? txt : '#000000'}
        onChange={(e) => { setTxt(e.target.value); onChange(e.target.value); }}
        style={{ width: 34, height: 30, padding: 0, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent' }}
      />
      <input
        className="input"
        style={{ width: 96 }}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => onChange(txt)}
        onKeyDown={(e) => { if (e.key === 'Enter') onChange(txt); }}
      />
      <div className="swatches">
        {swatches.map((c) => (
          <div
            key={c}
            className={`swatch ${txt === c ? 'on' : ''}`}
            style={{ background: c === 'transparent' ? 'linear-gradient(45deg,#ddd,#fff)' : c }}
            title={c}
            onClick={() => { setTxt(c); onChange(c); }}
          />
        ))}
      </div>
    </div>
  );
}

export function Seg<T extends string>({
  value, options, onChange,
}: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value, onChange, options,
}: {
  value: T; onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className="progress"><i style={{ width: `${pct}%` }} /></div>;
}

export function Empty({ text, icon = '📭', action }: { text: string; icon?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{text}</div>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/** 简易 Tabs */
export function Tabs<T extends string>({
  value, onChange, items,
}: {
  value: T; onChange: (v: T) => void; items: { value: T; label: string }[];
}) {
  return <Seg value={value} options={items} onChange={onChange} />;
}

/** 受控的可编辑标签（双击即改） */
export function EditableName({
  value, onCommit, className,
}: {
  value: string; onCommit: (v: string) => void; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  if (!editing) {
    return (
      <span className={className} onDoubleClick={() => setEditing(true)} title="双击重命名">
        {value}
      </span>
    );
  }
  return (
    <input
      className="input"
      autoFocus
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => { setEditing(false); if (txt.trim() && txt !== value) onCommit(txt.trim()); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { setEditing(false); if (txt.trim() && txt !== value) onCommit(txt.trim()); }
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

/** 简易多选列表（用于批量操作） */
export function useSelection<T>(): {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  isOn: (id: string) => boolean;
} {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const isOn = useCallback((id: string) => selected.has(id), [selected]);
  return useMemo(() => ({ selected, toggle, clear, isOn }), [selected, toggle, clear, isOn]);
}
