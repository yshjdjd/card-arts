import { rasterizeSvg } from '../lib/svgRaster';
import { projectFontSources } from '../lib/projectFonts';
import { loadFontSources } from '../lib/fontRuntime';
import React, { useState } from 'react';
import { useProject, useAssets } from '../state/store';
import { useToast, Modal, NumberInput, Select, Progress, Field as F } from '../components/ui';
import type { Card, Deck, ExportSettings, Field, Layout } from '../lib/types';
import { api, assetUrl } from '../api/client';
import { exportCSV, exportXLSX } from '../lib/table';
import { collectRefs } from '../lib/useImages';
import { downloadBlob, downloadJSON, safeName } from '../lib/utils';
import { db } from '../db/schema';
import type { RenderDone, RenderJob } from '../workers/cardRenderer.worker';
import { navigate } from '../state/store';

type Face = 'front' | 'back' | 'both';

export default function ExportPage() {
  const { content, project, update } = useProject();
  const { assets } = useAssets();
  const toast = useToast();

  const decks = content.decks ?? [];
  const [deckIds, setDeckIds] = useState<string[]>(decks.map((d) => d.id));
  const [face, setFace] = useState<Face>('both');
  const [dpi, setDpi] = useState(300);
  const [expand, setExpand] = useState(true);
  const [busy, setBusy] = useState<{ label: string; done: number; total: number } | null>(null);
  const [showTts, setShowTts] = useState(false);

  const settings = (content.settings ?? {}) as Record<string, unknown>;
  const exportSettings = (settings.export ?? {}) as Partial<ExportSettings>;
  const bleedMm = exportSettings.bleedMm ?? 3;

  const setExportSetting = async (patch: Record<string, unknown>) => {
    await update((c) => {
      const s = (c.settings ??= {}) as unknown as Record<string, unknown>;
      const e = (s.export ??= {}) as Record<string, unknown>;
      Object.assign(e, patch);
    }, '修改导出设置');
  };

  /** 展开 count 后的卡牌列表 */
  const expandedCards = (deck: Deck): Card[] => {
    if (!expand) return deck.cards;
    const out: Card[] = [];
    for (const c of deck.cards) {
      const n = Math.max(1, Math.round(Number(c.values?.count ?? 1) || 1));
      for (let i = 0; i < n; i++) out.push(c);
    }
    return out;
  };

  /* ---------------- 渲染引擎 ---------------- */
  const renderCards = async (
    jobs: { name: string; layout: Layout; card: Card | null; fields: Field[] }[],
    scale: number,
    bleedPx: number,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ name: string; blob: Blob }[]> => {
    const fonts = await projectFontSources(jobs.map((j) => j.layout), assets);
    const refs = collectRefs(jobs.map((j) => j.layout), jobs.flatMap((j) => j.card ? [j.card] : []), jobs.flatMap((j) => j.fields));
    const images: Record<string, string> = {};
    for (const id of refs.assets) {
      const a = assets.find((x) => x.id === id);
      if (a) images[id] = assetUrl(a.url);
    }
    const icons: Record<string, string> = {};
    for (const id of refs.icons) icons[id] = api.iconSvgUrl(id);

    const rasters: (() => void)[] = [];
    try {
      for (const id of Object.keys(icons)) { const raster = await rasterizeSvg(icons[id]); icons[id] = raster.url; rasters.push(raster.dispose); }
      for (const id of Object.keys(images)) if (assets.find((a) => a.id === id)?.mime === 'image/svg+xml') {
        const raster = await rasterizeSvg(images[id]); images[id] = raster.url; rasters.push(raster.dispose);
      }
    } catch (error) { rasters.forEach((dispose) => dispose()); throw error; }

    const useWorker = typeof Worker !== 'undefined' && jobs.length > 4;
    if (!useWorker) {
      try {
      await loadFontSources(fonts);
      const { renderToCanvas } = await import('../lib/render');
      const { useLayoutImages } = await import('../lib/useImages');
      void useLayoutImages;
      const out: { name: string; blob: Blob }[] = [];
      // 主线程直接渲染：先预载图片
      const loadImage = (url: string): Promise<HTMLImageElement | null> =>
        new Promise((res, reject) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => reject(new Error(`素材加载失败：${url}`)); i.src = url; });
      const imgMap: Record<string, HTMLImageElement> = {};
      await Promise.all(Object.entries(images).map(async ([k, u]) => { const r = await loadImage(u); if (r) imgMap[k] = r; }));
      const iconMap: Record<string, HTMLImageElement> = {};
      await Promise.all(Object.entries(icons).map(async ([k, u]) => { const r = await loadImage(u); if (r) iconMap[k] = r; }));

      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const cv = renderToCanvas(j.layout, j.card, {
          values: j.card?.values ?? {}, images: imgMap, icons: iconMap, scale, bleed: bleedPx,
        }, j.fields);
        const blob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b ?? new Blob()), 'image/png'));
        out.push({ name: j.name, blob });
        onProgress(i + 1, jobs.length);
      }
      return out;
      } finally { rasters.forEach((dispose) => dispose()); }
    }

    // Worker 并发
    const CONC = Math.min(4, Math.max(1, navigator.hardwareConcurrency ?? 2));
    const worker = new Worker(new URL('../workers/cardRenderer.worker.ts', import.meta.url), { type: 'module' });
    const results = new Map<string, Blob>();
    let cursor = 0;
    let done = 0;

    return await new Promise<{ name: string; blob: Blob }[]>((resolve, reject) => {
      const startNext = () => {
        if (cursor >= jobs.length) return;
        const j = jobs[cursor++];
        worker.postMessage({
          id: j.name, layout: j.layout, card: j.card, fields: j.fields,
          scale, bleed: bleedPx, images, icons, fonts,
        } as RenderJob);
      };
      worker.onmessage = (ev: MessageEvent<RenderDone>) => {
        const r = ev.data;
        if (!r.ok) { worker.terminate(); reject(new Error(r.error || '卡牌渲染失败')); return; }
        if (r.ok && r.blob) results.set(r.id, r.blob);
        done++;
        onProgress(done, jobs.length);
        if (done === jobs.length) {
          worker.terminate();
          resolve(jobs.map((j) => ({ name: j.name, blob: results.get(j.name) ?? new Blob() })));
        } else startNext();
      };
      worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message || '导出 Worker 发生错误')); };
      for (let i = 0; i < CONC; i++) startNext();
    }).finally(() => rasters.forEach((dispose) => dispose()));
  };

  const buildJobs = (): { name: string; layout: Layout; card: Card | null; fields: Field[] }[] => {
    const jobs: { name: string; layout: Layout; card: Card | null; fields: Field[] }[] = [];
    for (const deck of decks.filter((d) => deckIds.includes(d.id))) {
      const cards = expandedCards(deck);
      if (face !== 'back') {
        if (!deck.frontLayout) continue;
        cards.forEach((c, i) => jobs.push({
          name: `${safeName(deck.name)}/${String(i + 1).padStart(3, '0')}_${safeName(String(c.values?.name ?? 'card'))}_front.png`,
          layout: deck.frontLayout!, card: c, fields: deck.fields,
        }));
      }
      if (face !== 'front') {
        if (!deck.backLayout) continue;
        if (deck.useSharedBack) {
          jobs.push({ name: `${safeName(deck.name)}/back.png`, layout: deck.backLayout, card: null, fields: deck.fields });
        } else {
          cards.forEach((c, i) => jobs.push({
            name: `${safeName(deck.name)}/${String(i + 1).padStart(3, '0')}_${safeName(String(c.values?.name ?? 'card'))}_back.png`,
            layout: deck.backLayout!, card: c, fields: deck.fields,
          }));
        }
      }
    }
    return jobs;
  };

  /* ---------------- 导出动作 ---------------- */
  const doBackup = async () => {
    const p = await db.projects.get(project?.id ?? '');
    if (!p) return;
    downloadJSON(
      { format: 'cardarts.project.v1', exportedAt: new Date().toISOString(), name: p.name, content: p.content },
      `${safeName(p.name)}.cardarts.json`,
    );
    toast('已导出完整备份');
  };

  const doPngZip = async () => {
    try {
    const jobs = buildJobs();
    if (!jobs.length) { toast('没有可导出的内容（先确认牌组有正面/背面版式）', 'err'); return; }
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const scale = dpi / 300;
    const bleedPx = Math.round((bleedMm / 25.4) * dpi);
    setBusy({ label: '渲染卡图', done: 0, total: jobs.length });
    const files = await renderCards(jobs, scale, bleedPx, (d, t) => setBusy({ label: '渲染卡图', done: d, total: t }));
    setBusy({ label: '打包 ZIP', done: 0, total: 1 });
    for (const f of files) zip.file(f.name, f.blob);
    zip.file('manifest.json', JSON.stringify({
      format: 'cardarts.images.v1', dpi, bleedMm, face, generatedAt: new Date().toISOString(),
      files: files.map((f) => f.name),
    }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${safeName(project?.name ?? 'cards')}-${dpi}dpi.zip`);
    setBusy(null);
    toast(`已导出 ${files.length} 张图`, 'ok');
    } catch (error) { toast(`导出失败：${(error as Error).message}`, 'err'); }
    finally { setBusy(null); }
  };

  const doTts = async (mode: 'single' | 'per-deck') => {
    try {
    const JSZip = (await import('jszip')).default;
    const scale = dpi / 300;
    const chosen = decks.filter((d) => deckIds.includes(d.id));
    setBusy({ label: '生成 TTS 素材', done: 0, total: chosen.length });

    const buildOne = async (deck: Deck, zip: import('jszip')) => {
      const cards = expandedCards(deck);
      const jobs: { name: string; layout: Layout; card: Card | null; fields: Field[] }[] = [];
      cards.forEach((c, i) => jobs.push({
        name: `${safeName(deck.name)}_${String(i + 1).padStart(3, '0')}.png`,
        layout: deck.frontLayout!, card: c, fields: deck.fields,
      }));
      if (!deck.frontLayout) return { deck, names: [] as string[] };
      const files = await renderCards(jobs, scale, 0, () => {});
      for (const f of files) zip.file(`images/${f.name}`, f.blob);
      return { deck, names: files.map((f) => f.name) };
    };

    if (mode === 'single') {
      const zip = new JSZip();
      const decksJson: unknown[] = [];
      for (const deck of chosen) {
        if (!deck.frontLayout) continue;
        const r = await buildOne(deck, zip);
        decksJson.push(ttsDeckObject(r.deck, r.names));
      }
      zip.file('tts_decks.json', JSON.stringify(decksJson, null, 2));
      zip.file('README.txt', ttsReadme());
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${safeName(project?.name ?? 'tts')}-tts.zip`);
    } else {
      for (const deck of chosen) {
        if (!deck.frontLayout) continue;
        const zip = new JSZip();
        const r = await buildOne(deck, zip);
        zip.file('tts_deck.json', JSON.stringify(ttsDeckObject(r.deck, r.names), null, 2));
        zip.file('README.txt', ttsReadme());
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `${safeName(deck.name)}-tts.zip`);
      }
    }
    setBusy(null);
    toast('TTS 包已生成', 'ok');
    } catch (error) { toast(`导出失败：${(error as Error).message}`, 'err'); }
    finally { setBusy(null); }
  };

  if (!decks.length) {
    return <div className="card"><div className="bd">还没有牌组，先去创建。</div></div>;
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="card">
        <div className="hd">导出范围</div>
        <div className="bd">
          <div className="row wrap">
            {decks.map((d) => (
              <label key={d.id} className="row small" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={deckIds.includes(d.id)}
                  onChange={(e) => setDeckIds(e.target.checked ? [...deckIds, d.id] : deckIds.filter((x) => x !== d.id))}
                />
                {d.name}
              </label>
            ))}
          </div>
          <div className="row wrap mt16">
            <span className="small muted">面</span>
            <Select
              value={face} onChange={setFace}
              options={[{ value: 'both', label: '正面 + 背面' }, { value: 'front', label: '仅正面' }, { value: 'back', label: '仅背面' }]}
            />
            <span className="small muted">DPI</span>
            <NumberInput value={dpi} min={72} max={600} step={25} onChange={setDpi} />
            <span className="small muted">出血</span>
            <NumberInput value={bleedMm} min={0} max={10} step={0.5} suffix="mm" onChange={(v) => void setExportSetting({ bleedMm: v })} />
            <label className="row small" style={{ gap: 4 }}>
              <input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} />
              按「数量」展开
            </label>
          </div>
        </div>
      </div>

      {busy && (
        <div className="card mt16"><div className="bd">
          <div className="small">{busy.label}</div>
          <div className="mt8"><Progress done={busy.done} total={busy.total} /></div>
        </div></div>
      )}

      <div className="grid2 mt16">
        <div className="card">
          <div className="hd">数据与备份</div>
          <div className="bd">
            <div className="row wrap">
              <button className="btn primary" onClick={() => void doBackup()}>完整备份 .cardarts.json</button>
              <button className="btn" onClick={() => downloadJSON(content, `${safeName(project?.name ?? 'project')}-data.json`)}>卡牌数据 JSON</button>
              <button className="btn" onClick={() => exportCSV(decks.find((d) => deckIds.includes(d.id)) ?? decks[0], `${safeName(project?.name ?? 'cards')}.csv`)}>CSV</button>
              <button className="btn" onClick={() => void exportXLSX(decks.filter((d) => deckIds.includes(d.id)), `${safeName(project?.name ?? 'cards')}.xlsx`)}>XLSX</button>
            </div>
            <div className="small faint mt8">完整备份包含版式、字段、卡牌、文档，可在首页重新导入。</div>
          </div>
        </div>

        <div className="card">
          <div className="hd">图片与打印</div>
          <div className="bd">
            <div className="row wrap">
              <button className="btn primary" onClick={() => void doPngZip()}>PNG 打包 ZIP</button>
              <button className="btn" onClick={() => navigate(`print/${project?.id ?? ''}`)}>打开打印页</button>
              <button className="btn" onClick={() => setShowTts(true)}>Tabletop Simulator</button>
            </div>
            <div className="small faint mt8">
              打印页按 A4 排布，带裁切标记，用浏览器「打印 → 另存为 PDF」即可得到可打印文件。
            </div>
            <div className="row wrap mt8">
              <label className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={!!exportSettings.cutLines} onChange={(e) => void setExportSetting({ cutLines: e.target.checked })} />
                裁切线
              </label>
              <label className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={!!exportSettings.duplex} onChange={(e) => void setExportSetting({ duplex: e.target.checked })} />
                双面打印
              </label>
              <label className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={!!exportSettings.flipOnBack} onChange={(e) => void setExportSetting({ flipOnBack: e.target.checked })} />
                背面翻转
              </label>
            </div>
          </div>
        </div>
      </div>

      {showTts && (
        <Modal
          title="导出 Tabletop Simulator 包"
          onClose={() => setShowTts(false)}
          footer={<button className="btn" onClick={() => setShowTts(false)}>关闭</button>}
        >
          <div className="small muted" style={{ lineHeight: 1.8, marginBottom: 12 }}>
            TTS 的自定义牌组需要图片的可访问 URL。本工具会生成：
            <div>· <span className="mono">images/*.png</span> —— 按「数量」展开后的卡图</div>
            <div>· <span className="mono">tts_deck.json</span> —— 可直接粘贴进 TTS 存档的 ObjectStates</div>
            <div>· 图片上传后把 json 里的 <span className="mono">REPLACE_ME</span> 换成实际 URL 即可。</div>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => { setShowTts(false); void doTts('single'); }}>单个 ZIP（全部牌组）</button>
            <button className="btn" onClick={() => { setShowTts(false); void doTts('per-deck'); }}>每个牌组一个 ZIP</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- TTS 对象结构 ---------------- */

function ttsDeckObject(deck: Deck, imageNames: string[]): unknown {
  const numCards = imageNames.length;
  return {
    Name: 'Custom_Token',
    Transform: { posX: 0, posY: 1, posZ: 0, rotX: 0, rotY: 180, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
    Nickname: deck.name,
    Description: '',
    CardID: 100,
    CustomDeck: {
      1: {
        FaceURL: 'REPLACE_ME',
        BackURL: 'REPLACE_ME',
        NumWidth: 1,
        NumHeight: numCards,
        BackIsHidden: true,
        UniqueBack: false,
        Type: 0,
      },
    },
    ContainedObjects: imageNames.map((n, i) => ({
      CardID: (i + 1) * 100,
      Name: 'Card',
      Nickname: String(deck.cards[i]?.values?.name ?? n),
      Description: '',
      CustomDeck: { 1: { FaceURL: `REPLACE_ME/images/${n}`, NumWidth: 1, NumHeight: numCards } },
    })),
    DeckIDs: imageNames.map((_, i) => (i + 1) * 100),
  };
}

function ttsReadme(): string {
  return [
    'CardArts — Tabletop Simulator 导出包',
    '',
    '1. 把 images/ 里的 PNG 上传到任意可公开访问的位置（Steam Cloud / 图床 / 本地服务器）。',
    '2. 打开 tts_deck.json，把所有 REPLACE_ME 替换成第 1 步得到的 URL 前缀。',
    '3. 在 TTS 里：Objects → Custom → Deck，或把 json 里的 ObjectStates 粘贴进存档。',
    '',
    'FaceURL 指向每张牌的正面，BackURL 指向共用牌背。',
  ].join('\n');
}

void F;
