import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject, useAssets } from '../state/store';
import { useToast, useConfirm, Modal, Select, NumberInput, ColorInput, Empty } from '../components/ui';
import { AssetField, uploadImageFiles } from '../components/AssetPicker';
import type { Card, Deck, ElementKind, Field, Layout, LayoutElement } from '../lib/types';
import { renderLayout, renderToCanvas, type ImageLike } from '../lib/render';
import { useLayoutImages } from '../lib/useImages';
import { CARD_PRESETS, FONTS } from '../lib/presets';
import { clamp, move, uid } from '../lib/utils';
import ConditionEditor, { describe } from '../features/editor/ConditionEditor';
import IconPicker from '../features/editor/IconPicker';
import { aligned, bounds, cropRect, distributed, fitZoom, hitElement, selectionIds, selectionUnitCount, resizedRotated, snapped, transformElements, type Alignment, type Box } from '../lib/editorGeometry';
import { fontKey } from '../lib/fontIdentity';
import { previewUrl } from '../api/uploader';

const KIND_LABEL: Record<ElementKind, string> = {
  text: '文本', image: '图片', icon: '图标', rectangle: '矩形', ellipse: '椭圆', line: '线条',
};
const KIND_ICON: Record<ElementKind, string> = {
  text: 'T', image: '🖼', icon: '✨', rectangle: '▭', ellipse: '◯', line: '—',
};

export default function EditorPage() {
  const { content, update, undo, redo, canUndo, canRedo } = useProject();
  const { assets, remoteId, refresh } = useAssets();
  const { project } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const decks = content.decks ?? [];
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '');
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [zoom, setZoom] = useState(0.5);
  const [selected, setSelected] = useState<string[]>([]);
  const [sampleIdx, setSampleIdx] = useState(0);
  const [showPreset, setShowPreset] = useState(false);
  const [preview, setPreview] = useState<Layout | null>(null);
  const [cropDraft, setCropDraft] = useState<Partial<LayoutElement> | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const [cropPerCard, setCropPerCard] = useState(true);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; value: number }[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [gallery, setGallery] = useState(false);
  const [galleryPage, setGalleryPage] = useState(0);
  const [issues, setIssues] = useState<{ cardIndex: number; elementId: string; message: string }[]>([]);
  const [checking, setChecking] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null), wrapRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const clipboard = useRef<LayoutElement[]>([]), space = useRef(false), cleanup = useRef<(() => void) | null>(null);
  const layoutKey = side === 'front' ? 'frontLayout' : 'backLayout';
  const stored = deck?.[layoutKey] ?? null;
  const layout = preview ?? stored;
  const cards = deck?.cards ?? [];
  const sampleCard = cards[Math.min(sampleIdx, Math.max(0, cards.length - 1))] ?? null;
  const { images, icons, ready, error: renderError } = useLayoutImages([deck?.frontLayout, deck?.backLayout], assets, cards, deck?.fields || []);
  const selection = layout?.elements.filter((e) => selected.includes(e.id) && !e.hidden && !e.locked) ?? [];
  const sel = selection.length === 1 ? selection[0] : null;
  const box = selection.length ? bounds(selection) : null;
  const fontOptions = [...FONTS.map((f) => ({ key: f.key, name: f.name })), ...assets.filter((a) => a.kind === 'font').map((a) => ({ key: fontKey(a.id), name: a.name }))];
  const cardForRender = useMemo(() => {
    if (!sampleCard || !cropId) return sampleCard;
    const overrides = { ...sampleCard.layoutOverrides };
    if (!cropPerCard) delete overrides[cropId];
    if (cropDraft) overrides[cropId] = { ...overrides[cropId], ...cropDraft };
    return { ...sampleCard, layoutOverrides: overrides };
  }, [sampleCard, cropId, cropPerCard, cropDraft]);
  useEffect(() => { cleanup.current?.(); setPreview(null); setCropId(null); setCropDraft(null); setSelected([]); setIssues([]); setSampleIdx(0); setGalleryPage(0); }, [deck?.id, side]);
  useEffect(() => () => cleanup.current?.(), []);
  const patchLayout = async (fn: (l: Layout) => void, label = '编辑版式') => {
    const id = deck?.id;
    try { await update((c) => {
      const d = c.decks.find((x) => x.id === id); if (!d) throw new Error('牌组已不存在');
      d[layoutKey] ??= { id: uid(), name: side === 'front' ? '正面' : '背面', width: 750, height: 1050, widthMm: 63.5, heightMm: 88.9,
        backgroundColor: '#ffffff', borderColor: '#e5e7eb', borderWidth: 1, borderRadius: 24, elements: [] };
      fn(d[layoutKey]!);
    }, label); } catch (error) { toast((error as Error).message, 'err'); }
  };
  const patchElement = (id: string, patch: Partial<LayoutElement>, label = '修改元素') => patchLayout((l) => {
    const el = l.elements.find((e) => e.id === id); if (el) Object.assign(el, patch);
  }, label);
  const patchMany = (elements: LayoutElement[], label: string) => patchLayout((l) => {
    for (const next of elements) { const el = l.elements.find((e) => e.id === next.id); if (el && !el.locked) Object.assign(el, next); }
  }, label);
  useEffect(() => {
    if (!layout || !ready) return;
    const canvasLayout = cropDraft && cropId && !sampleCard ? { ...layout, elements: layout.elements.map((el) => el.id === cropId ? { ...el, ...cropDraft } : el) } : layout;
    const cv = renderToCanvas(canvasLayout, cardForRender, { values: cardForRender?.values ?? {}, images, icons, scale: zoom, placeholders: true }, deck?.fields ?? []);
    const target = canvasRef.current; if (!target) return;
    target.width = cv.width; target.height = cv.height; target.getContext('2d')?.drawImage(cv, 0, 0);
  }, [layout, cardForRender, cropDraft, cropId, images, icons, ready, zoom, deck?.fields]);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  const listen = (move: (e: MouseEvent) => void, up: () => void) => {
    cleanup.current?.();
    const end = () => { cleanup.current?.(); up(); };
    cleanup.current = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end); cleanup.current = null; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  };
  const commitCrop = async (id: string, patch: Partial<LayoutElement>) => {
    setSaving(true);
    try {
      if (cropPerCard && sampleCard) {
        const did = deck!.id, cid = sampleCard.id;
        await update((c) => { const card = c.decks.find((d) => d.id === did)?.cards.find((a) => a.id === cid);
          if (!card) throw new Error('卡牌已不存在');
          (card.layoutOverrides ??= {})[id] = { ...card.layoutOverrides?.[id], ...patch };
        }, '调整单卡图片裁切');
      } else await patchElement(id, patch, '调整图片裁切');
    } catch (error) { toast((error as Error).message, 'err'); }
    finally { setCropDraft(null); setSaving(false); }
  };
  const startGesture = (e: React.MouseEvent, handle?: string) => {
    if (!layout || saving || space.current || e.button !== 0) return;
    e.preventDefault(); stageRef.current?.focus({ preventScroll: true });
    const start = point(e);
    const hit = handle ? selection[0] : [...layout.elements].reverse().find((el) => !el.hidden && !el.locked && hitElement(el, start.x, start.y));
    if (cropId && hit?.id === cropId && !handle && hit.kind === 'image') {
      const actual = { ...hit, ...cardForRender?.layoutOverrides?.[hit.id] };
      const img = images[String(hit.fieldId ? sampleCard?.values[hit.fieldId] || hit.assetId || '' : hit.assetId || '')];
      if (!img) return;
      const frame = cropRect(img.width, img.height, hit, hit.imageFit || 'cover', actual.imageZoom, actual.imageFocusX, actual.imageFocusY);
      let final: Partial<LayoutElement> = {};
      listen((event) => {
        const p = point(event);
        final = { imageFocusX: clamp((actual.imageFocusX ?? 0.5) + (frame.width === hit.width ? 0 : (p.x - start.x) / (hit.width - frame.width)), 0, 1),
          imageFocusY: clamp((actual.imageFocusY ?? 0.5) + (frame.height === hit.height ? 0 : (p.y - start.y) / (hit.height - frame.height)), 0, 1) };
        setCropDraft(final);
      }, () => { if (Object.keys(final).length) void commitCrop(hit.id, final); });
      return;
    }
    if (!hit) {
      const initial = e.shiftKey ? selected : [];
      if (!e.shiftKey) setSelected([]);
      let area: Box | null = null;
      listen((event) => { const p = point(event); area = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) }; setMarquee(area); }, () => {
        if (area) setSelected(selectionIds(layout.elements, [...initial, ...layout.elements.filter((el) => el.x >= area!.x && el.y >= area!.y && el.x + el.width <= area!.x + area!.width && el.y + el.height <= area!.y + area!.height).map((el) => el.id)]));
        setMarquee(null);
      }); return;
    }
    const hits = e.altKey ? [hit.id] : selectionIds(layout.elements, [hit.id]);
    let ids = selected.includes(hit.id) ? selected : hits;
    if (e.shiftKey && !handle) { ids = selected.includes(hit.id) ? selected.filter((id) => !hits.includes(id)) : [...new Set([...selected, ...hits])]; setSelected(ids); return; }
    setSelected(ids); setCropId(null);
    const elements = layout.elements.filter((el) => ids.includes(el.id) && !el.locked && !el.hidden);
    const origin = bounds(elements); let final: LayoutElement[] | null = null;
    listen((event) => {
      const p = point(event); let dx = p.x - start.x, dy = p.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.1) return;
      let target = { ...origin };
      if (handle) {
        const right = handle.endsWith('r'), bottom = handle.startsWith('b');
        target.width = Math.max(8, origin.width + dx * (right ? 1 : -1));
        target.height = Math.max(8, origin.height + dy * (bottom ? 1 : -1));
        if (event.shiftKey) { const ratio = target.width / Math.max(1, origin.width); target.height = origin.height * ratio; }
        if (!right) target.x = origin.x + origin.width - target.width;
        if (!bottom) target.y = origin.y + origin.height - target.height;
      } else {
        target.x += dx; target.y += dy;
        if (snap && !event.altKey) {
          const snappedResult = snapped(target, [{ x: 0, y: 0, width: layout.width, height: layout.height }, ...layout.elements.filter((el) => !ids.includes(el.id) && !el.hidden)], 6 / zoom);
          target = snappedResult.box; setGuides(snappedResult.guides);
        }
      }
      final = handle && elements.length === 1 && elements[0].rotation ? [resizedRotated(elements[0], dx, dy, handle, event.shiftKey)] : transformElements(elements, origin, target);
      const byId = new Map(final.map((el) => [el.id, el]));
      setPreview({ ...layout, elements: layout.elements.map((el) => byId.get(el.id) || el) });
    }, () => {
      setGuides([]);
      if (!final) { setPreview(null); return; }
      const geometry = final.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
      setSaving(true);
      void patchLayout((l) => { for (const patch of geometry) { const el = l.elements.find((a) => a.id === patch.id); if (el && !el.locked) Object.assign(el, patch); } }, handle ? '缩放所选元素' : '移动所选元素')
        .finally(() => { setPreview(null); setSaving(false); });
    });
  };
  const duplicate = (items = selection) => {
    const groups = new Map<string, string>();
    const copies = items.map((el) => {
      if (el.groupId && !groups.has(el.groupId)) groups.set(el.groupId, uid());
      return { ...structuredClone(el), id: uid(), name: `${el.name} 副本`, x: el.x + 20, y: el.y + 20, groupId: el.groupId ? groups.get(el.groupId) : undefined };
    });
    if (copies.length) { void patchLayout((l) => { l.elements.push(...copies); }, '复制元素'); setSelected(copies.map((e) => e.id)); }
  };
  const removeSelection = () => { const ids = selection.map((e) => e.id); void patchLayout((l) => { l.elements = l.elements.filter((e) => !ids.includes(e.id)); }, '删除所选元素'); setSelected([]); };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.code === 'Space') { e.preventDefault(); space.current = true; return; }
      const command = e.ctrlKey || e.metaKey;
      if (command && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? redo() : undo()); return; }
      if (command && e.key.toLowerCase() === 'y') { e.preventDefault(); void redo(); return; }
      if (command && e.key.toLowerCase() === 'a' && layout) { e.preventDefault(); setSelected(selectionIds(layout.elements, layout.elements.map((el) => el.id))); return; }
      if (command && e.key.toLowerCase() === 'c' && selection.length) { e.preventDefault(); clipboard.current = structuredClone(selection); return; }
      if (command && e.key.toLowerCase() === 'v' && clipboard.current.length) { e.preventDefault(); duplicate(clipboard.current); return; }
      if (command && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
      if (command && e.key.toLowerCase() === 'g') { e.preventDefault(); const groupId = e.shiftKey ? undefined : uid(); void patchMany(selection.map((el) => ({ ...el, groupId })), e.shiftKey ? '解组' : '组合'); return; }
      if (!selection.length || saving) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelection(); return; }
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (delta) { e.preventDefault(); const step = e.shiftKey ? 10 : 1; void patchMany(selection.map((el) => ({ ...el, x: el.x + delta[0] * step, y: el.y + delta[1] * step })), '微调位置'); }
    };
    const keyup = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    const blur = () => { space.current = false; cleanup.current?.(); setPreview(null); setGuides([]); setMarquee(null); };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); };
  }, [layout, selected, saving, undo, redo, deck?.id]);
  const fit = () => { if (layout && wrapRef.current) setZoom(fitZoom(layout.width, layout.height, wrapRef.current.clientWidth, wrapRef.current.clientHeight)); };
  useEffect(() => {
    const wrap = wrapRef.current;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom((z) => clamp(z * (event.deltaY > 0 ? 0.9 : 1.1), 0.05, 3)); }
    };
    wrap?.addEventListener('wheel', wheel, { passive: false });
    return () => wrap?.removeEventListener('wheel', wheel);
  }, [deck?.id]);
  const addElement = (kind: ElementKind) => {
    const el: LayoutElement = { id: uid(), kind, name: KIND_LABEL[kind], x: 60, y: 60, width: 240, height: 120, rotation: 0, fill: ['text', 'icon'].includes(kind) ? 'transparent' : '#e5e7eb', color: '#111827' };
    if (kind === 'text') Object.assign(el, { text: '文本内容', fontSize: 32, fontFamily: String(content.settings?.defaultFont || 'sans'), wrapMode: 'word', horizontalAlign: 'center', verticalAlign: 'middle' });
    // 没图时也要是块看得见、能拖能选的区域（渲染层会画占位框）
    if (kind === 'image') Object.assign(el, { width: 240, height: 240, imageFit: 'cover', assetId: assets.find((a) => a.kind === 'image')?.id });
    if (kind === 'icon') Object.assign(el, { iconId: 'delapouite/sword-altar', width: 96, height: 96 });
    if (kind === 'line') Object.assign(el, { height: 4, fill: '#111827', borderWidth: 2 });
    void patchLayout((l) => { l.elements.push(el); }, '新增元素'); setSelected([el.id]);
  };

  /**
   * 把图片文件拖到画布上：落在插图框里就替换它的图，
   * 落在空处就新建一个插图框并在原位置摆好。
   * 这是「插图框 = 可以往里放图的区域」最直观的那一步。
   */
  const dropImages = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (!files.length || !layout) return;
    const ids = await uploadImageFiles(files, { projectId: project?.id ?? '', remoteId, refresh });
    if (!ids.length) { toast('图片上传失败', 'err'); return; }
    const p = point(e);
    const hit = [...layout.elements].reverse().find((el) => el.kind === 'image' && !el.locked && hitElement(el, p.x, p.y));
    if (hit) {
      await patchElement(hit.id, { assetId: ids[0] }, '插图框换图');
      setSelected([hit.id]);
      toast(`「${hit.name}」已换成新图`, 'ok');
      return;
    }
    const el: LayoutElement = {
      id: uid(), kind: 'image', name: '插图框', x: p.x, y: p.y, width: 240, height: 240,
      rotation: 0, fill: '#e5e7eb', color: '#111827', imageFit: 'cover', assetId: ids[0],
    };
    await patchLayout((l) => { l.elements.push(el); }, '拖入图片');
    setSelected([el.id]);
    toast('已插入插图框', 'ok');
  };
  const check = async () => {
    if (!layout || !ready) return;
    setChecking(true); const result: typeof issues = [];
    const context = document.createElement('canvas').getContext('2d')!;
    try { for (let i = 0; i < Math.max(1, cards.length); i++) {
      const diagnostics: { elementId: string; message: string }[] = [];
      renderLayout(context, layout, cards[i] || null, { values: cards[i]?.values || {}, images, icons, scale: 1, diagnostics }, deck?.fields || []);
      result.push(...diagnostics.map((d) => ({ ...d, cardIndex: i })));
      if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setIssues(result); toast(result.length ? `发现 ${result.length} 项版式问题` : '检查通过：未发现文字溢出或元素越界', result.length ? 'info' : 'ok'); }
    finally { setChecking(false); }
  };
  if (!deck) return <Empty icon="🎴" text="请先创建牌组" />;
  const actualCrop = cropId ? { ...layout?.elements.find((el) => el.id === cropId), ...cardForRender?.layoutOverrides?.[cropId], ...cropDraft } : null;
  const align = (mode: Alignment) => { if (layout) void patchMany(aligned(selection, mode, selectionUnitCount(selection) === 1 ? { x: 0, y: 0, width: layout.width, height: layout.height } : undefined), '对齐元素'); };
  return <div className="editor">
    <div className="pane">
      <div className="ph"><span style={{ flex: 1 }}>图层</span><select className="select" style={{ width: 92 }} value={side} onChange={(e) => setSide(e.currentTarget.value as 'front' | 'back')}><option value="front">正面</option><option value="back">背面</option></select></div>
      <div className="row wrap" style={{ padding: 8, gap: 6 }}>{(Object.keys(KIND_LABEL) as ElementKind[]).map((kind) => <button className="btn sm" key={kind} onClick={() => addElement(kind)}>{KIND_ICON[kind]} {KIND_LABEL[kind]}</button>)}</div>
      <div className="pb">{(layout?.elements || []).slice().reverse().map((el) => <div key={el.id} className={`layer ${selected.includes(el.id) ? 'sel' : ''}`} onClick={(e) => {
        if (el.locked) { setSelected([]); return; }
        const ids = e.altKey ? [el.id] : selectionIds(layout!.elements, [el.id]);
        setSelected(e.shiftKey ? selected.includes(el.id) ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])] : ids); setCropId(null);
      }}><span>{el.groupId ? '▣' : KIND_ICON[el.kind]}</span><span className="nm">{el.name}</span>
        <button className="iconbtn" onClick={(e) => { e.stopPropagation(); void patchElement(el.id, { hidden: !el.hidden }); }}>{el.hidden ? '🚫' : '👁'}</button>
        <button className="iconbtn" onClick={(e) => { e.stopPropagation(); void patchElement(el.id, { locked: !el.locked }); }}>{el.locked ? '🔒' : '🔓'}</button>
      </div>)}</div>
      <div className="small faint" style={{ padding: 8 }}>Shift 多选 · 空白处框选 · Alt 点选组内元素 · 空格拖动画布</div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="row wrap" style={{ padding: 8, gap: 6, borderBottom: '1px solid var(--border)' }}>
        <select className="select" style={{ width: 170 }} value={deck.id} onChange={(e) => setDeckId(e.currentTarget.value)}>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <button className="btn sm" onClick={() => setShowPreset(true)}>尺寸</button>
        <button className="btn sm" disabled={!canUndo} onClick={() => void undo()}>↶</button><button className="btn sm" disabled={!canRedo} onClick={() => void redo()}>↷</button>
        <button className="btn sm" onClick={() => setZoom((z) => clamp(z - 0.1, 0.05, 3))}>−</button><span className="small">{Math.round(zoom * 100)}%</span><button className="btn sm" onClick={() => setZoom((z) => clamp(z + 0.1, 0.05, 3))}>+</button><button className="btn sm" onClick={fit}>适应</button>
        <label className="small"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.currentTarget.checked)} />吸附</label>
        <label className="small"><input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.currentTarget.checked)} />安全区</label>
        <button className="btn sm" disabled={!ready} onClick={() => setGallery(true)}>多卡预览</button><button className="btn sm" disabled={!ready || checking} onClick={() => void check()}>{checking ? '检查中…' : '检查全套'}</button>
      </div>
      <div className="row wrap" style={{ padding: 6, gap: 4 }}>
        <button className="btn sm" disabled={!cards.length} onClick={() => { setSampleIdx((i) => Math.max(0, i - 1)); setCropDraft(null); }}>‹</button>
        <span className="small">{String(sampleCard?.values.name || `${sampleIdx + 1}/${cards.length}`)}</span>
        <button className="btn sm" disabled={!cards.length} onClick={() => { setSampleIdx((i) => Math.min(cards.length - 1, i + 1)); setCropDraft(null); }}>›</button>
        <span className="small faint">{saving ? '正在提交…' : selection.length ? `已选 ${selection.length} 个元素` : '拖动只在松手时保存一次'}</span>
        {selection.length > 0 && <><select className="select" style={{ width: 100 }} value="" onChange={(e) => { if (e.currentTarget.value) align(e.currentTarget.value as Alignment); }}><option value="">对齐…</option>{[['left','左'],['center','水平居中'],['right','右'],['top','上'],['middle','垂直居中'],['bottom','下']].map(([k,n]) => <option key={k} value={k}>{n}</option>)}</select>
          <button className="btn sm" disabled={selectionUnitCount(selection) < 3} onClick={() => void patchMany(distributed(selection, 'x'), '水平分布')}>水平分布</button><button className="btn sm" disabled={selectionUnitCount(selection) < 3} onClick={() => void patchMany(distributed(selection, 'y'), '垂直分布')}>垂直分布</button>
          <button className="btn sm" onClick={() => duplicate()}>复制</button>
          <button className="btn sm" disabled={selection.length < 2} onClick={() => { const groupId = uid(); void patchMany(selection.map((el) => ({ ...el, groupId })), '组合'); }}>组合</button><button className="btn sm" onClick={() => void patchMany(selection.map((el) => ({ ...el, groupId: undefined })), '解组')}>解组</button></>}
      </div>
      {renderError && <div className="danger" role="alert">{renderError}</div>}
      {cropId && <div className="row wrap" style={{ padding: 8 }}><b className="small">裁切：拖动图片调整焦点</b><label className="small"><input type="checkbox" checked={cropPerCard && !!sampleCard} disabled={!sampleCard} onChange={(e) => setCropPerCard(e.currentTarget.checked)} />仅此卡牌</label>
        <button className="btn sm" disabled={saving} onClick={() => void commitCrop(cropId, { imageZoom: Math.max(1, (actualCrop?.imageZoom || 1) - 0.1) })}>缩小</button><span className="small">{Math.round((actualCrop?.imageZoom || 1) * 100)}%</span><button className="btn sm" disabled={saving} onClick={() => void commitCrop(cropId, { imageZoom: Math.min(8, (actualCrop?.imageZoom || 1) + 0.1) })}>放大</button>
        <button className="btn sm" onClick={() => void commitCrop(cropId, { imageZoom: 1, imageFocusX: 0.5, imageFocusY: 0.5 })}>重置</button><button className="btn sm" onClick={() => setCropId(null)}>完成</button></div>}
      <div className="canvas-wrap" ref={wrapRef} onMouseDownCapture={(e) => {
        if (!space.current && e.button !== 1) return;
        e.preventDefault(); e.stopPropagation(); const wrap = wrapRef.current!, x = e.clientX, y = e.clientY, left = wrap.scrollLeft, top = wrap.scrollTop;
        listen((event) => { wrap.scrollLeft = left - (event.clientX - x); wrap.scrollTop = top - (event.clientY - y); }, () => {});
      }}>
        {!layout ? <Empty icon="✏️" text="这一面还没有版式" action={<button className="btn primary" onClick={() => void patchLayout(() => {})}>创建版式</button>} /> :
          <div
            ref={stageRef} className="canvas-stage" tabIndex={0} aria-label="卡牌版式画布"
            style={{ width: layout.width * zoom, height: layout.height * zoom }}
            onMouseDown={(e) => startGesture(e)}
            onDoubleClick={(e) => { const p = point(e); const el = [...layout.elements].reverse().find((el) => el.kind === 'image' && !el.locked && hitElement(el, p.x, p.y)); if (el) { setSelected([el.id]); setCropId(el.id); } }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={(e) => { void dropImages(e); }}
          >
            <canvas ref={canvasRef} style={{ width: layout.width * zoom, height: layout.height * zoom }} />
            {showSafe && <div style={{ pointerEvents: 'none', position: 'absolute', inset: `${3 * (layout.width / (layout.widthMm || 63.5)) * zoom}px`, border: '1px dashed #16a34a' }} title="3mm 安全区" />}
            {guides.map((g) => <div key={g.axis} style={{ position: 'absolute', pointerEvents: 'none', background: '#f43f5e', ...(g.axis === 'x' ? { left: g.value * zoom, top: 0, width: 1, height: '100%' } : { top: g.value * zoom, left: 0, height: 1, width: '100%' }) }} />)}
            {marquee && <div style={{ position: 'absolute', pointerEvents: 'none', left: marquee.x * zoom, top: marquee.y * zoom, width: marquee.width * zoom, height: marquee.height * zoom, background: '#3b82f633', border: '1px solid #3b82f6' }} />}
            {box && <div className="sel" style={{ left: box.x * zoom, top: box.y * zoom, width: box.width * zoom, height: box.height * zoom, transform: sel?.rotation ? `rotate(${sel.rotation}deg)` : undefined }}><span className="lbl">{sel?.name || `${selection.length} 个元素`}</span>{!cropId && ['tl','tr','bl','br'].map((h) => <div key={h} className={`h ${h}`} onMouseDown={(e) => { e.stopPropagation(); startGesture(e, h); }} />)}</div>}
          </div>}
      </div>
      {!!issues.length && <div style={{ maxHeight: 150, overflow: 'auto', padding: 8 }}>{issues.slice(0, 500).map((issue, i) => <button className="btn sm" key={i} onClick={() => { setSampleIdx(issue.cardIndex); setSelected([issue.elementId]); }}>{String(cards[issue.cardIndex]?.values.name || issue.cardIndex + 1)} · {layout?.elements.find((el) => el.id === issue.elementId)?.name}: {issue.message}</button>)}{issues.length > 500 && <span>仅显示前 500 项，共 {issues.length} 项</span>}</div>}
    </div>
    <div className="pane right"><div className="ph">属性</div><div className="pb">
      {selection.length > 1 ? <Section title="批量操作"><Row label="字体"><select className="select" value="" onChange={(e) => { const fontFamily = e.currentTarget.value; void patchMany(selection.map((el) => el.kind === 'text' ? { ...el, fontFamily } : el), '批量设定字体'); }}><option value="">选择字体…</option>{fontOptions.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}</select></Row><button className="btn danger" onClick={removeSelection}>删除所选元素</button></Section> : sel ?
        <><ElementProps key={sel.id} el={sel} deck={deck} assets={assets} onPatch={(patch) => void patchElement(sel.id, patch)} onDelete={async () => { if (await ask({ title: '删除元素', text: `删除「${sel.name}」？`, danger: true })) removeSelection(); }} onReorder={(dir) => void patchLayout((l) => { const i = l.elements.findIndex((e) => e.id === sel.id); l.elements = move(l.elements, i, clamp(i + dir, 0, l.elements.length - 1)); }, '调整层级')} />
        {sel.kind === 'image' && <div style={{ padding: 12 }}><button className="btn" onClick={() => setCropId(sel.id)}>编辑图片裁切 / 焦点</button>{sampleCard?.layoutOverrides?.[sel.id] && <button className="btn sm ghost" onClick={() => void update((c) => { const card = c.decks.find((d) => d.id === deck.id)?.cards.find((a) => a.id === sampleCard.id); if (card?.layoutOverrides) delete card.layoutOverrides[sel.id]; }, '清除单卡裁切')}>此卡重新跟随模板裁切</button>}</div>}</> : layout ? <LayoutProps layout={layout} assets={assets} onPatch={(patch) => void patchLayout((l) => Object.assign(l, patch))} /> : null}
    </div></div>
    {showPreset && <Modal title="卡牌尺寸" onClose={() => setShowPreset(false)}><div className="grid2">{CARD_PRESETS.map((p) => <button key={p.key} className="btn" onClick={() => { void patchLayout((l) => Object.assign(l, { width: p.width, height: p.height, widthMm: p.widthMm, heightMm: p.heightMm }), '修改尺寸'); setShowPreset(false); }}>{p.name} {p.width}×{p.height}</button>)}</div>
      <NumberInput value={layout?.width || 750} onChange={(width) => void patchLayout((l) => { l.width = width; })} /><NumberInput value={layout?.height || 1050} onChange={(height) => void patchLayout((l) => { l.height = height; })} /></Modal>}
    {gallery && layout && <Modal title="多卡同步预览" wide onClose={() => setGallery(false)}><div className="row"><button className="btn sm" disabled={!galleryPage} onClick={() => setGalleryPage((p) => p - 1)}>上一页</button><span>{galleryPage + 1} / {Math.max(1, Math.ceil(cards.length / 12))}</span><button className="btn sm" disabled={(galleryPage + 1) * 12 >= cards.length} onClick={() => setGalleryPage((p) => p + 1)}>下一页</button><button className="btn sm" onClick={() => { const longest = cards.map((c, i) => ({ i, length: layout.elements.filter((e) => e.kind === 'text').reduce((n, e) => n + String(e.fieldId ? c.values[e.fieldId] || '' : e.text || '').length, 0) })).sort((a,b) => b.length-a.length)[0]; if (longest) { setSampleIdx(longest.i); setGalleryPage(Math.floor(longest.i / 12)); } }}>定位最长文本卡</button></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>{cards.slice(galleryPage * 12, galleryPage * 12 + 12).map((card, i) => <button className="btn" key={card.id} style={{ display: 'block', padding: 6 }} onClick={() => { setSampleIdx(galleryPage * 12 + i); setGallery(false); }}><CardThumbnail layout={layout} card={card} images={images} icons={icons} fields={deck.fields} /><div className="small">{String(card.values.name || galleryPage * 12 + i + 1)}</div></button>)}</div></Modal>}
    {confirmNode}
  </div>;
}
function CardThumbnail({ layout, card, fields, images, icons }: { layout: Layout; card: Card; fields: Field[]; images: Record<string, ImageLike>; icons: Record<string, ImageLike> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const cv = renderToCanvas(layout, card, { values: card.values, images, icons, scale: 180 / layout.width, placeholders: true }, fields); const target = ref.current; if (target) { target.width = cv.width; target.height = cv.height; target.getContext('2d')?.drawImage(cv, 0, 0); } }, [layout, card, images, icons, fields]);
  return <canvas ref={ref} style={{ width: '100%', height: 'auto' }} />;
}

/* ---------------- 属性面板 ---------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="prop-sec"><h4>{title}</h4>{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <span className="small muted" style={{ width: 62, flex: '0 0 62px' }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function LayoutProps({
  layout, assets, onPatch,
}: {
  layout: Layout; assets: ReturnType<typeof useAssets>['assets']; onPatch: (p: Partial<Layout>) => void;
}) {
  const imgAssets = assets.filter((a) => a.kind === 'image');
  return (
    <>
      <Section title="画布">
        <Row label="名称"><input className="input" value={layout.name} onChange={(e) => onPatch({ name: e.target.value })} /></Row>
        <Row label="宽"><NumberInput value={layout.width} onChange={(v) => onPatch({ width: v })} /></Row>
        <Row label="高"><NumberInput value={layout.height} onChange={(v) => onPatch({ height: v })} /></Row>
        <Row label="宽 mm"><NumberInput value={layout.widthMm ?? 0} step={0.1} onChange={(v) => onPatch({ widthMm: v })} /></Row>
        <Row label="高 mm"><NumberInput value={layout.heightMm ?? 0} step={0.1} onChange={(v) => onPatch({ heightMm: v })} /></Row>
      </Section>
      <Section title="外观">
        <Row label="背景色"><ColorInput value={layout.backgroundColor} onChange={(v) => onPatch({ backgroundColor: v })} /></Row>
        <Row label="边框色"><ColorInput value={layout.borderColor} onChange={(v) => onPatch({ borderColor: v })} /></Row>
        <Row label="边框宽"><NumberInput value={layout.borderWidth} min={0} onChange={(v) => onPatch({ borderWidth: v })} /></Row>
        <Row label="圆角"><NumberInput value={layout.borderRadius} min={0} onChange={(v) => onPatch({ borderRadius: v })} /></Row>
        <Row label="背景图">
          <select
            className="select"
            value={layout.backgroundAssetId ?? ''}
            onChange={(e) => onPatch({ backgroundAssetId: e.target.value || null })}
          >
            <option value="">无</option>
            {imgAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Row>
      </Section>
      <div className="small faint" style={{ padding: 12 }}>在画布上点选一个元素即可编辑它的属性。</div>
    </>
  );
}

function ElementProps({
  el, deck, assets, onPatch, onDelete, onReorder,
}: {
  el: LayoutElement;
  deck: Deck;
  assets: ReturnType<typeof useAssets>['assets'];
  onPatch: (p: Partial<LayoutElement>) => void;
  onDelete: () => void;
  onReorder: (dir: -1 | 1) => void;
}) {
  const [showIcon, setShowIcon] = useState(false);
  const textFields = deck.fields ?? [];
  const imgAssets = assets.filter((a) => a.kind === 'image');
  /** 只有 image 类型的字段才能给插图框供图 */
  const imageFields = textFields.filter((f) => f.type === 'image');

  return (
    <>
      <Section title="基础">
        <Row label="名称"><input className="input" value={el.name} onChange={(e) => onPatch({ name: e.target.value })} /></Row>
        <Row label="X"><NumberInput value={el.x} onChange={(v) => onPatch({ x: v })} /></Row>
        <Row label="Y"><NumberInput value={el.y} onChange={(v) => onPatch({ y: v })} /></Row>
        <Row label="宽"><NumberInput value={el.width} min={1} onChange={(v) => onPatch({ width: v })} /></Row>
        <Row label="高"><NumberInput value={el.height} min={1} onChange={(v) => onPatch({ height: v })} /></Row>
        <Row label="旋转"><NumberInput value={el.rotation} onChange={(v) => onPatch({ rotation: v })} suffix="°" /></Row>
        <div className="row">
          <button className="btn sm" onClick={() => onReorder(1)}>上移一层</button>
          <button className="btn sm" onClick={() => onReorder(-1)}>下移一层</button>
          <button className="btn sm danger" onClick={onDelete}>删除</button>
        </div>
      </Section>

      {el.kind === 'text' && (
        <Section title="文本">
          <Row label="绑定字段">
            <select className="select" value={el.fieldId ?? ''} onChange={(e) => onPatch({ fieldId: e.target.value || undefined })}>
              <option value="">（静态文本）</option>
              {textFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Row>
          {!el.fieldId && (
            <Row label="内容">
              <textarea className="input" rows={3} value={el.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} />
            </Row>
          )}
          <Row label="富文本"><input type="checkbox" checked={!!el.richText} onChange={(e) => onPatch({ richText: e.currentTarget.checked })} /></Row>
          {el.richText && <div className="small faint" style={{ padding: '0 12px 12px' }}>
            支持 **加粗**、*斜体*、[color=#dc2626]彩色[/color]、[size=36]大字[/size]、[icon:作者/图标名]、[image:素材id]。
            {el.fieldId ? '请在绑定字段的数据中填写这些标记。' : <div className="row wrap">
              <button className="btn sm" onClick={() => onPatch({ text: (el.text || '') + '**重点**' })}>插入粗体</button>
              <button className="btn sm" onClick={() => setShowIcon(true)}>插入图标</button>
              <select className="select" value="" onChange={(e) => onPatch({ text: (el.text || '') + `[image:${e.currentTarget.value}]` })}><option value="">插入项目图片…</option>{imgAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </div>}
          </div>}
          <Row label="字号"><NumberInput value={el.fontSize ?? 24} min={1} onChange={(v) => onPatch({ fontSize: v })} /></Row>
          <Row label="自动缩放">
            <input type="checkbox" checked={!!el.autoFit} onChange={(e) => onPatch({ autoFit: e.target.checked })} />
          </Row>
          {el.autoFit && (
            <>
              <Row label="最大字号"><NumberInput value={el.maxFontSize ?? el.fontSize ?? 24} min={1} onChange={(v) => onPatch({ maxFontSize: v })} /></Row>
              <Row label="最小字号"><NumberInput value={el.minFontSize ?? 8} min={1} onChange={(v) => onPatch({ minFontSize: v })} /></Row>
            </>
          )}
          <Row label="行高"><NumberInput value={el.lineHeight ?? 1.25} step={0.05} min={0.5} onChange={(v) => onPatch({ lineHeight: v })} /></Row>
          <Row label="字体">
            <select className="select" value={el.fontFamily ?? 'sans'} onChange={(e) => onPatch({ fontFamily: e.target.value })}>
              {FONTS.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
              {assets.filter((a) => a.kind === 'font').map((a) => <option key={a.id} value={fontKey(a.id)}>{a.name}</option>)}
            </select>
          </Row>
          <Row label="字重">
            <Select
              value={el.fontWeight ?? 'normal'}
              onChange={(v) => onPatch({ fontWeight: v })}
              options={[{ value: 'normal', label: '常规' }, { value: 'bold', label: '加粗' }]}
            />
          </Row>
          <Row label="水平">
            <Select
              value={el.horizontalAlign ?? 'left'}
              onChange={(v) => onPatch({ horizontalAlign: v })}
              options={[{ value: 'left', label: '左' }, { value: 'center', label: '居中' }, { value: 'right', label: '右' }]}
            />
          </Row>
          <Row label="垂直">
            <Select
              value={el.verticalAlign ?? 'top'}
              onChange={(v) => onPatch({ verticalAlign: v })}
              options={[{ value: 'top', label: '上' }, { value: 'middle', label: '居中' }, { value: 'bottom', label: '下' }]}
            />
          </Row>
          <Row label="折行">
            <Select
              value={el.wrapMode ?? 'word'}
              onChange={(v) => onPatch({ wrapMode: v })}
              options={[
                { value: 'none', label: '不折行' }, { value: 'word', label: '按词' },
                { value: 'anywhere', label: '任意位置' }, { value: 'keepWord', label: '保持英文单词' },
              ]}
            />
          </Row>
          <Row label="颜色"><ColorInput value={el.color} onChange={(v) => onPatch({ color: v })} /></Row>
          <Row label="描边宽"><NumberInput value={el.borderWidth ?? 0} min={0} onChange={(v) => onPatch({ borderWidth: v })} /></Row>
          {!!el.borderWidth && (
            <Row label="描边色"><ColorInput value={el.borderColor ?? '#000'} onChange={(v) => onPatch({ borderColor: v })} /></Row>
          )}
        </Section>
      )}

      {el.kind === 'image' && (
        <Section title="图片">
          <Row label="来源">
            <Select
              value={el.fieldId ? 'field' : 'asset'}
              onChange={(v) => onPatch(v === 'field'
                ? { fieldId: imageFields[0]?.id, assetId: undefined }
                : { fieldId: undefined })}
              options={[
                { value: 'asset', label: '固定图片' },
                ...(imageFields.length ? [{ value: 'field', label: '按卡牌字段取图' }] : []),
              ]}
            />
          </Row>

          {el.fieldId ? (
            <>
              <Row label="图片字段">
                <select className="select" value={el.fieldId} onChange={(e) => onPatch({ fieldId: e.target.value || undefined })}>
                  {imageFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Row>
              <div className="small faint">
                绑定后每张卡可以在「卡牌数据」里各自选图；卡片没填时回退到下面这张固定图片。
                {!imageFields.length && ' 当前牌组还没有 image 类型字段，请先到牌组页新增。'}
              </div>
              <div style={{ marginTop: 8 }}>
                <AssetField
                  label="默认图片" value={el.assetId}
                  onChange={(id) => onPatch({ assetId: id || undefined })}
                />
              </div>
            </>
          ) : (
            <div style={{ padding: '4px 0' }}>
              <AssetField
                label="选择素材或上传图片" value={el.assetId}
                onChange={(id) => onPatch({ assetId: id || undefined })}
              />
            </div>
          )}

          {!el.assetId && !el.fieldId && (
            <div className="small warn">还没选图：画布上会显示空的插图框占位，选好素材后即显示图片。</div>
          )}

          <Row label="填充">
            <Select
              value={el.imageFit ?? 'cover'}
              onChange={(v) => onPatch({ imageFit: v })}
              options={[{ value: 'cover', label: '裁剪填满' }, { value: 'contain', label: '完整包含' }]}
            />
          </Row>
          <Row label="圆角"><NumberInput value={el.borderRadius ?? 0} min={0} onChange={(v) => onPatch({ borderRadius: v })} /></Row>
        </Section>
      )}

      {el.kind === 'icon' && (
        <Section title="图标">
          <Row label="图标">
            <button className="btn sm" style={{ width: '100%' }} onClick={() => setShowIcon(true)}>
              {el.iconId ? el.iconId.split('/').pop() : '选择图标…'}
            </button>
          </Row>
          {el.iconId && (
            <div style={{ textAlign: 'center', margin: '6px 0' }}>
              <img src={`/api/v1/icons/${el.iconId}/svg?color=${(el.color || '#111827').replace('#', '')}`} alt="" style={{ width: 64, height: 64 }} />
            </div>
          )}
          <Row label="颜色"><ColorInput value={el.color} onChange={(v) => onPatch({ color: v })} /></Row>
        </Section>
      )}

      {(el.kind === 'rectangle' || el.kind === 'ellipse' || el.kind === 'line') && (
        <Section title="形状">
          <Row label="填充"><ColorInput value={el.fill} onChange={(v) => onPatch({ fill: v })} /></Row>
          <Row label="填充透明">
            <NumberInput value={el.fillOpacity ?? 1} step={0.05} min={0} max={1} onChange={(v) => onPatch({ fillOpacity: v })} />
          </Row>
          <Row label="边框色"><ColorInput value={el.borderColor ?? '#000'} onChange={(v) => onPatch({ borderColor: v })} /></Row>
          <Row label="边框宽"><NumberInput value={el.borderWidth ?? 0} min={0} onChange={(v) => onPatch({ borderWidth: v })} /></Row>
          <Row label="边框样式">
            <Select
              value={el.borderStyle ?? 'solid'}
              onChange={(v) => onPatch({ borderStyle: v })}
              options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]}
            />
          </Row>
          {el.kind === 'rectangle' && (
            <Row label="圆角"><NumberInput value={el.borderRadius ?? 0} min={0} onChange={(v) => onPatch({ borderRadius: v })} /></Row>
          )}
        </Section>
      )}

      <Section title="数量展开">
        <div className="small faint" style={{ marginBottom: 8 }}>
          按某个数字字段的值把这个元素重复绘制多次（如费用宝石）。
        </div>
        <Row label="字段">
          <select
            className="select"
            value={el.countFieldId ?? ''}
            onChange={(e) => onPatch({ countFieldId: e.target.value || undefined })}
          >
            <option value="">（关闭）</option>
            {textFields.filter((f) => f.type === 'number').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Row>
        {el.countFieldId && (
          <>
            <Row label="上限"><NumberInput value={el.countMax ?? 10} min={1} onChange={(v) => onPatch({ countMax: v })} /></Row>
            <Row label="间距"><NumberInput value={el.countSpacing ?? 0} onChange={(v) => onPatch({ countSpacing: v })} /></Row>
            <Row label="方向">
              <Select
                value={el.countDirection ?? 'horizontal'}
                onChange={(v) => onPatch({ countDirection: v })}
                options={[{ value: 'horizontal', label: '横向' }, { value: 'vertical', label: '纵向' }]}
              />
            </Row>
          </>
        )}
      </Section>

      <Section title="显示条件">
        <ConditionEditor
          value={el.displayCondition}
          fields={textFields}
          onChange={(c) => onPatch({ displayCondition: c })}
        />
        <div className="small faint mt8">{describe(el.displayCondition, textFields)}</div>
      </Section>

      {showIcon && (
        <IconPicker
          onClose={() => setShowIcon(false)}
          onPick={(id) => { onPatch(el.kind === 'text' ? { text: (el.text || '') + `[icon:${id}]` } : { iconId: id }); setShowIcon(false); }}
        />
      )}
    </>
  );
}

void previewUrl;
