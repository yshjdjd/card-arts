import React, { useEffect, useMemo, useState } from 'react';
import { useProject, useAssets } from '../state/store';
import { renderToCanvas } from '../lib/render';
import { useLayoutImages } from '../lib/useImages';
import type { Card, Deck, Layout } from '../lib/types';
import { NumberInput, Select, Progress } from '../components/ui';
import { navigate } from '../state/store';

const PAGE_MM: Record<string, { w: number; h: number }> = { A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 } };

export default function PrintPage() {
  const { content, project } = useProject();
  const { assets } = useAssets();
  const decks = content.decks ?? [];
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '');
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];

  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4');
  const [marginMm, setMarginMm] = useState(10);
  const [gapMm, setGapMm] = useState(0);
  const [dpi, setDpi] = useState(300);
  const [duplex, setDuplex] = useState(true);
  const [flipOnBack, setFlipOnBack] = useState(false);
  const [cutLines, setCutLines] = useState(true);
  const [side, setSide] = useState<'both' | 'front' | 'back'>('both');
  const [rendered, setRendered] = useState<{ front: string[]; back: string[] }>({ front: [], back: [] });
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const settings = (content.settings ?? {}) as Record<string, unknown>;
  const es = (settings.export ?? {}) as Record<string, unknown>;

  useEffect(() => {
    if (es.bleedMm !== undefined) void es.bleedMm;
    if (es.duplex !== undefined) setDuplex(!!es.duplex);
    if (es.flipOnBack !== undefined) setFlipOnBack(!!es.flipOnBack);
    if (es.cutLines !== undefined) setCutLines(!!es.cutLines);
    if (es.pageSize === 'A4' || es.pageSize === 'Letter') setPageSize(es.pageSize as 'A4' | 'Letter');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { images, icons, ready, error: renderError } = useLayoutImages([deck?.frontLayout, deck?.backLayout], assets, deck?.cards || [], deck?.fields || []);

  const cardWmm = deck?.frontLayout?.widthMm ?? 63.5;
  const cardHmm = deck?.frontLayout?.heightMm ?? 88.9;
  const page = PAGE_MM[pageSize];

  const cols = Math.max(1, Math.floor((page.w - marginMm * 2 + gapMm) / (cardWmm + gapMm)));
  const rows = Math.max(1, Math.floor((page.h - marginMm * 2 + gapMm) / (cardHmm + gapMm)));
  const perPage = cols * rows;

  const expanded = useMemo<Card[]>(() => {
    if (!deck) return [];
    const out: Card[] = [];
    for (const c of deck.cards) {
      const n = Math.max(1, Math.round(Number(c.values?.count ?? 1) || 1));
      for (let i = 0; i < n; i++) out.push(c);
    }
    return out;
  }, [deck]);

  const doRender = async () => {
    if (!deck || !ready || renderError) return;
    const scale = dpi / 300;
    const total = (side !== 'back' ? expanded.length : 0) + (side !== 'front' ? (deck.useSharedBack ? 1 : expanded.length) : 0);
    setProgress({ done: 0, total });

    const render = (layout: Layout, card: Card | null): string => {
      const cv = renderToCanvas(layout, card, {
        values: card?.values ?? {}, images, icons, scale, bleed: 0,
      }, deck.fields);
      return cv.toDataURL('image/png');
    };

    const front: string[] = [];
    const back: string[] = [];
    if (side !== 'back' && deck.frontLayout) {
      for (const c of expanded) {
        front.push(render(deck.frontLayout, c));
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    }
    if (side !== 'front' && deck.backLayout) {
      if (deck.useSharedBack) {
        back.push(render(deck.backLayout, null));
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      } else {
        for (const c of expanded) {
          back.push(render(deck.backLayout, c));
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        }
      }
    }
    setRendered({ front, back });
  };

  useEffect(() => {
    if (ready && deck) void doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, deck, dpi, side, images, icons]);

  /** 背面需要镜像排布：每一行左右翻转，才能和正面对上 */
  const mirror = (arr: string[]): string[] => {
    const out: string[] = [];
    for (let r = 0; r < arr.length; r += cols) {
      const row = arr.slice(r, r + cols);
      out.push(...(flipOnBack ? row.slice().reverse() : row.slice().reverse()));
    }
    return out;
  };

  const pagesOf = (list: string[], isBack: boolean): string[][] => {
    if (!list.length) return [];
    const src = isBack ? mirror(list) : list;
    const out: string[][] = [];
    for (let i = 0; i < src.length; i += perPage) {
      const chunk = src.slice(i, i + perPage);
      // 共享牌背：整页重复同一张
      if (isBack && deck?.useSharedBack && chunk.length < perPage && src.length === 1) {
        out.push(Array(perPage).fill(src[0]));
        continue;
      }
      while (chunk.length < perPage) chunk.push('');
      out.push(chunk);
    }
    return out;
  };

  const frontPages = side === 'back' ? [] : pagesOf(rendered.front, false);
  const backPages = side === 'front' || !duplex ? [] : pagesOf(
    deck?.useSharedBack && rendered.back.length === 1
      ? Array(Math.max(1, Math.ceil(expanded.length / perPage) * perPage)).fill(rendered.back[0])
      : rendered.back,
    true,
  );

  const Sheet = ({ pages, isBack }: { pages: string[][]; isBack: boolean }) => (
    <>
      {pages.map((chunk, pi) => (
        <div
          key={pi}
          className="print-page"
          style={{
            width: `${page.w}mm`, height: `${page.h}mm`,
            padding: `${marginMm}mm`, boxSizing: 'border-box',
            display: 'block', position: 'relative',
          }}
        >
          <div
            className={`print-sheet ${cutLines ? 'cutlines' : ''}`}
            style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${cardWmm}mm)`, gap: `${gapMm}mm` }}
          >
            {chunk.map((src, ci) => (
              <div
                key={ci}
                className="cell"
                style={{
                  width: `${cardWmm}mm`, height: `${cardHmm}mm`,
                  outline: cutLines ? '1px dashed #999' : undefined,
                  transform: isBack && flipOnBack ? 'rotate(180deg)' : undefined,
                }}
              >
                {src && <img src={src} style={{ width: '100%', height: '100%', display: 'block' }} alt="" />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg)' }}>
      {renderError && <div role="alert" className="danger no-print">无法渲染：{renderError}</div>}
      {/* 控制条（打印时隐藏） */}
      <div className="no-print row wrap" style={{ padding: 12, background: 'var(--panel)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 5 }}>
        <button className="btn" onClick={() => navigate(`p/${project?.id ?? ''}/export`)}>← 返回</button>
        <select className="select" style={{ width: 170 }} value={deck?.id ?? ''} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="small muted">纸张</span>
        <Select value={pageSize} onChange={setPageSize} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} />
        <span className="small muted">边距</span>
        <NumberInput value={marginMm} min={0} max={30} onChange={setMarginMm} suffix="mm" />
        <span className="small muted">间距</span>
        <NumberInput value={gapMm} min={0} max={20} onChange={setGapMm} suffix="mm" />
        <span className="small muted">DPI</span>
        <NumberInput value={dpi} min={150} max={600} step={50} onChange={setDpi} />
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} />双面</label>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={flipOnBack} onChange={(e) => setFlipOnBack(e.target.checked)} />背面翻转</label>
        <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={cutLines} onChange={(e) => setCutLines(e.target.checked)} />裁切线</label>
        <span style={{ flex: 1 }} />
        <span className="small muted">每页 {cols}×{rows} = {perPage} 张</span>
        <button className="btn primary" disabled={!ready || !!renderError} onClick={() => void doRender()}>重新渲染</button>
        <button className="btn primary" disabled={!ready || !!renderError} onClick={() => window.print()}>打印 / 另存 PDF</button>
      </div>

      {progress.total > 0 && progress.done < progress.total && (
        <div style={{ padding: 16, maxWidth: 400 }}>
          <Progress done={progress.done} total={progress.total} />
          <div className="small muted mt8">渲染中 {progress.done}/{progress.total}</div>
        </div>
      )}

      <div className="print-root" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {!rendered.front.length && !rendered.back.length ? (
          <div className="muted">点「重新渲染」生成打印稿</div>
        ) : (
          <>
            {frontPages.length > 0 && (
              <>
                <div className="no-print small muted">正面 · {frontPages.length} 页</div>
                <Sheet pages={frontPages} isBack={false} />
              </>
            )}
            {backPages.length > 0 && (
              <>
                <div className="no-print small muted">背面 · {backPages.length} 页</div>
                <Sheet pages={backPages} isBack />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
