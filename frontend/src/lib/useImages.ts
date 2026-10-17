import { useEffect, useRef, useState } from 'react';
import { inlineReferences } from './textLayout';
import { interpolate, type ImageLike } from './render';
import type { Card, Field, Layout, LayoutElement } from './types';
import { rasterizeSvg } from './svgRaster';
import { projectFontSources } from './projectFonts';
import { loadFontSources } from './fontRuntime';
import { api, assetUrl, type RemoteAssetDTO } from '../api/client';

/** 收集版式里用到的素材 / 图标 id */
export function collectRefs(layouts: (Layout | null | undefined)[], cards: Card[] = [], fields: Field[] = []): { assets: string[]; icons: string[] } {
  const assets = new Set<string>();
  const icons = new Set<string>();
  for (const l of layouts) {
    if (!l) continue;
    if (l.backgroundAssetId) assets.add(l.backgroundAssetId);
    for (const el of l.elements ?? []) {
      if (el.kind === 'image' && el.assetId) assets.add(el.assetId);
      if (el.kind === 'image' && el.fieldId) for (const card of cards) { const id = card.values[el.fieldId]; if (typeof id === 'string' && id) assets.add(id); }
      if (el.kind === 'icon' && el.fieldId) for (const option of Object.values(fields.find((f) => f.id === el.fieldId)?.optionIcons || {})) icons.add(option.id);
      if (el.kind === 'icon' && el.iconId) icons.add(el.iconId);
      if (el.kind === 'text' && el.richText) {
        const texts = [el.text || '', ...cards.map((c) => interpolate(el.fieldId ? String(c.values[el.fieldId] || '') : el.text || '', c.values))];
        for (const text of texts) for (const ref of inlineReferences(text)) (ref.kind === 'icon' ? icons : assets).add(ref.id);
      }
    }
  }
  return { assets: [...assets], icons: [...icons] };
}

async function loadImage(url: string, svg = false): Promise<ImageLike | null> {
  const raster = svg ? await rasterizeSvg(url) : null;
  try { return await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = raster?.url || url;
  }); } finally { raster?.dispose(); }
}

/**
 * 预加载版式引用的素材与图标为可直接 drawImage 的对象。
 * 返回 ready=false 时说明还在加载，界面上先显示占位。
 */
export function useLayoutImages(
  layouts: (Layout | null | undefined)[],
  assets: RemoteAssetDTO[],
  cards: Card[] = [],
  fields: Field[] = [],
): { images: Record<string, ImageLike>; icons: Record<string, ImageLike>; ready: boolean; error: string } {
  const [images, setImages] = useState<Record<string, ImageLike>>({});
  const [icons, setIcons] = useState<Record<string, ImageLike>>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef<Record<string, ImageLike>>({});

  const fontIds = layouts.flatMap((l) => l?.elements.map((e) => e.fontFamily || '') || []).join(',');
  const assetIds = collectRefs(layouts, cards, fields).assets.join(',');
  const iconIds = collectRefs(layouts, cards, fields).icons.join(',');

  useEffect(() => {
    let alive = true;
    setReady(false); setError('');
    const aIds = assetIds ? assetIds.split(',') : [];
    const iIds = iconIds ? iconIds.split(',') : [];

    (async () => {
      await loadFontSources(await projectFontSources(layouts, assets));
      const imgEntries: Record<string, ImageLike> = {};
      await Promise.all(
        aIds.map(async (id) => {
          const key = `asset:${id}`;
          if (cache.current[key]) { imgEntries[id] = cache.current[key]; return; }
          const a = assets.find((x) => x.id === id);
          if (!a) return;
          const got = await loadImage(assetUrl(a.url), a.mime === 'image/svg+xml');
          if (got && alive) { cache.current[key] = got; imgEntries[id] = got; }
        }),
      );

      const iconEntries: Record<string, ImageLike> = {};
      await Promise.all(
        iIds.map(async (id) => {
          const key = `icon:${id}`;
          if (cache.current[key]) { iconEntries[id] = cache.current[key]; return; }
          const got = await loadImage(api.iconSvgUrl(id), true);
          if (got && alive) { cache.current[key] = got; iconEntries[id] = got; }
        }),
      );

      if (!alive) return;
      setImages(imgEntries);
      setIcons(iconEntries);
      setReady(true);
    })().catch((err) => { if (alive) setError((err as Error).message); });

    return () => { alive = false; };
  }, [assetIds, iconIds, fontIds, assets]);

  return { images, icons, ready, error };
}
