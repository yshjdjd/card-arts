/// <reference lib="webworker" />
/**
 * 批量渲染 Worker：导出 PNG / 打印时把成百上千张牌丢进来并行出图，
 * 主线程只负责拼 ZIP，界面不会卡死。
 */
import { loadFontSources, type FontSource } from '../lib/fontRuntime';
import { renderLayout, type ImageLike, type RenderOptions } from '../lib/render';
import type { Card, Field, Layout } from '../lib/types';

export interface RenderJob {
  id: string;
  layout: Layout;
  card: Card | null;
  fields: Field[];
  scale: number;
  bleed: number;
  fonts?: FontSource[];
  images: Record<string, string>;  // assetId -> url
  icons: Record<string, string>;   // iconId -> url
}

export interface RenderDone {
  id: string;
  ok: boolean;
  blob?: Blob;
  error?: string;
}

async function loadImages(map: Record<string, string>): Promise<Record<string, ImageLike>> {
  const out: Record<string, ImageLike> = {};
  await Promise.all(
    Object.entries(map).map(async ([k, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`素材读取失败（${res.status}）：${url}`);
        if (url.endsWith('.svg') || (res.headers.get('content-type') ?? '').includes('svg')) {
          const bmp = await svgToBitmap(await res.text());
          if (!bmp) throw new Error('SVG 解码失败，请在导出前转换为位图');
          out[k] = bmp;
        } else {
          out[k] = await createImageBitmap(await res.blob());
        }
      } catch (error) {
        throw new Error(`无法渲染素材 ${k}：${(error as Error).message}`);
      }
    }),
  );
  return out;
}

let svgSeq = 0;
async function svgToBitmap(svg: string): Promise<ImageBitmap | null> {
  try {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}
void svgSeq;

self.onmessage = async (ev: MessageEvent<RenderJob>) => {
  const job = ev.data;
  try {
    await loadFontSources(job.fonts || []);
    const [images, icons] = await Promise.all([loadImages(job.images), loadImages(job.icons)]);
    const bleed = job.bleed * job.scale;
    const cv = new OffscreenCanvas(
      Math.max(1, Math.round(job.layout.width * job.scale + bleed * 2)),
      Math.max(1, Math.round(job.layout.height * job.scale + bleed * 2)),
    );
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 上下文');
    const opts: RenderOptions = {
      values: job.card?.values ?? {},
      images, icons, scale: job.scale, bleed: job.bleed, outline: false,
    };
    renderLayout(ctx, job.layout, job.card, opts, job.fields);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    const msg: RenderDone = { id: job.id, ok: true, blob };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    const msg: RenderDone = { id: job.id, ok: false, error: (e as Error).message };
    (self as unknown as Worker).postMessage(msg);
  }
};
