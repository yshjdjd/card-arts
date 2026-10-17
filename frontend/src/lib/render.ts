/**
 * 卡牌渲染核心。纯 Canvas 2D 实现，主线程与 Web Worker 共用同一套代码，
 * 因此导出 / 打印 / 编辑器预览在任何地方都能得到完全一致的画面。
 */
import type { AnyCondition, Card, Condition, Field, Layout, LayoutElement } from './types';
import { layoutText } from './textLayout';
import { cropRect } from './editorGeometry';

export type ImageLike = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export interface RenderContext {
  /** 字段值 -> 文本 */
  values: Record<string, unknown>;
  /** assetId -> 已解码图片 */
  images: Record<string, ImageLike>;
  /** 图标 url -> 已解码图片（iconId 直接是 game-icons 路径） */
  icons: Record<string, ImageLike>;
  /** 缩放系数：编辑器预览用小比例，导出用 1 */
  scale: number;
  /** 调试：绘制元素外框 */
  outline?: boolean;
  diagnostics?: { elementId: string; message: string }[];
}

/* ---------------- 字段绑定 ---------------- */

const BIND_RE = /\{([^{}]+)\}/g;

/** 把 `攻击力：{atk}` 里的 {atk} 替换成卡牌对应字段值 */
export function interpolate(text: string, values: Record<string, unknown>): string {
  return String(text ?? '').replace(BIND_RE, (_, key: string) => {
    const v = values?.[key.trim()];
    if (v === undefined || v === null || v === '') return '';
    return Array.isArray(v) ? v.join(', ') : String(v);
  });
}

/** 列出文本里引用到的字段 id，用于「绑定了哪些字段」提示 */
export function usedFields(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(BIND_RE)) out.push(m[1].trim());
  return out;
}

/* ---------------- 显示条件 ---------------- */

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseFloat(String(v ?? ''));
  return Number.isNaN(n) ? 0 : n;
}

function compare(a: unknown, op: Condition['operator'], b: unknown): boolean {
  switch (op) {
    case 'equals':
      return String(a ?? '') === String(b ?? '');
    case 'notEquals':
      return String(a ?? '') !== String(b ?? '');
    case 'gt': return toNum(a) > toNum(b);
    case 'gte': return toNum(a) >= toNum(b);
    case 'lt': return toNum(a) < toNum(b);
    case 'lte': return toNum(a) <= toNum(b);
    case 'contains':
      return String(a ?? '').includes(String(b ?? ''));
    case 'isEmpty':
      return a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);
    case 'isNotEmpty':
      return !(a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0));
    default:
      return true;
  }
}

export function evaluate(cond: AnyCondition | undefined, values: Record<string, unknown>): boolean {
  if (!cond) return true;
  if (cond.type === 'group') {
    const list = cond.conditions ?? [];
    if (!list.length) return true;
    return cond.operator === 'all'
      ? list.every((c) => evaluate(c, values))
      : list.some((c) => evaluate(c, values));
  }
  return compare(values?.[cond.fieldId], cond.operator, cond.value);
}

/* ---------------- 图形工具 ---------------- */

export function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function setDash(ctx: AnyCtx, style: string | undefined, w: number): void {
  const lw = Math.max(0.5, w);
  ctx.setLineDash(
    style === 'dashed' ? [lw * 3, lw * 2] : style === 'dotted' ? [lw, lw] : [],
  );
}

/** cover / contain 计算目标矩形 */
export function fitRect(
  iw: number, ih: number, dx: number, dy: number, dw: number, dh: number,
  mode: 'cover' | 'contain',
): [number, number, number, number] {
  if (!iw || !ih) return [dx, dy, dw, dh];
  const s = mode === 'cover' ? Math.max(dw / iw, dh / ih) : Math.min(dw / iw, dh / ih);
  const w = iw * s;
  const h = ih * s;
  return [dx + (dw - w) / 2, dy + (dh - h) / 2, w, h];
}

/* ---------------- 文本排版 ---------------- */

function splitLines(raw: string, mode: string | undefined): string[] {
  const paras = String(raw).split('\n');
  if (mode === 'none') return paras;
  return paras; // 换行始终是硬换行
}

/** 按可用宽度折行；keepWord 尽量不拆英文单词 */
function wrapLine(ctx: AnyCtx, line: string, maxW: number, mode: string | undefined): string[] {
  if (!line) return [''];
  if (maxW <= 0) return [line];
  if (ctx.measureText(line).width <= maxW) return [line];

  const out: string[] = [];
  if (mode === 'anywhere' || mode === 'keepWord') {
    let cur = '';
    let word = '';
    const flushWord = () => {
      if (!word) return;
      if (ctx.measureText(cur + word).width > maxW && cur) {
        out.push(cur);
        cur = word;
      } else {
        cur += word;
      }
      word = '';
    };
    for (const ch of line) {
      const isAscii = /[A-Za-z0-9'’\-]/.test(ch);
      if (isAscii && mode === 'keepWord') {
        word += ch;
      } else {
        flushWord();
        if (ctx.measureText(cur + ch).width > maxW && cur) {
          out.push(cur);
          cur = ch;
        } else {
          cur += ch;
        }
      }
    }
    flushWord();
    if (cur) out.push(cur);
  } else {
    // word：CJK 逐字，ASCII 尽量成词
    let cur = '';
    for (const ch of line) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        out.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

function buildLines(
  ctx: AnyCtx, raw: string, maxW: number, wrap: string | undefined,
): string[] {
  const out: string[] = [];
  for (const p of splitLines(raw, wrap)) out.push(...wrapLine(ctx, p, maxW, wrap));
  return out;
}

/** 自动缩字号：从 max 往下试，直到能塞进盒子 */
function autoFitSize(
  ctx: AnyCtx, text: string, boxW: number, boxH: number,
  max: number, min: number, lh: number, wrap: string | undefined,
): { size: number; lines: string[] } {
  let best = { size: min, lines: [text] as string[] };
  for (let s = max; s >= min; s -= Math.max(0.5, (max - min) / 24)) {
    ctx.font = ctx.font.replace(/\d+(\.\d+)?px/, `${s}px`);
    const lines = buildLines(ctx, text, boxW, wrap);
    const h = lines.length * s * lh;
    if (h <= boxH && lines.every((l) => ctx.measureText(l).width <= boxW + 0.5)) {
      return { size: s, lines };
    }
    best = { size: s, lines };
  }
  return best;
}

/* ---------------- 元素绘制 ---------------- */

function drawElement(
  ctx: AnyCtx, el: LayoutElement, rc: RenderContext, fields: Field[],
): void {
  if (el.hidden) return;
  const s = rc.scale;
  const x = el.x * s, y = el.y * s, w = el.width * s, h = el.height * s;

  ctx.save();
  ctx.globalAlpha = 1;

  // 旋转围绕元素中心
  if (el.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((el.rotation * Math.PI) / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }

  switch (el.kind) {
    case 'rectangle':
    case 'ellipse': {
      const bw = (el.borderWidth ?? 0) * s;
      if (el.fill && el.fill !== 'transparent' && (el.fillOpacity ?? 1) > 0) {
        ctx.globalAlpha = el.fillOpacity ?? 1;
        ctx.fillStyle = el.fill;
        if (el.kind === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          if (el.borderRadius) roundRect(ctx, x, y, w, h, el.borderRadius * s);
          else ctx.rect(x, y, w, h);
          ctx.fill();
        }
      }
      if (bw > 0 && el.borderColor) {
        ctx.globalAlpha = el.borderOpacity ?? 1;
        ctx.strokeStyle = el.borderColor;
        ctx.lineWidth = bw;
        setDash(ctx, el.borderStyle, bw);
        if (el.kind === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, (w - bw) / 2, (h - bw) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          if (el.borderRadius) roundRect(ctx, x + bw / 2, y + bw / 2, w - bw, h - bw, el.borderRadius * s);
          else ctx.rect(x + bw / 2, y + bw / 2, w - bw, h - bw);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      break;
    }

    case 'line': {
      ctx.globalAlpha = el.fillOpacity ?? 1;
      ctx.strokeStyle = el.fill || el.color || '#000';
      ctx.lineWidth = Math.max(0.5, (el.borderWidth ?? 1) * s);
      setDash(ctx, el.borderStyle, ctx.lineWidth);
      ctx.beginPath();
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }

    case 'image': {
      const img = el.assetId ? rc.images[el.assetId] : undefined;
      if (!img) { rc.diagnostics?.push({ elementId: el.id, message: `找不到图片素材 ${el.assetId || ''}` }); break; }
      ctx.save();
      if (el.borderRadius) {
        roundRect(ctx, x, y, w, h, el.borderRadius * s);
        ctx.clip();
      } else {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }
      const iw = 'width' in img ? img.width : 0;
      const ih = 'height' in img ? img.height : 0;
      const crop = cropRect(iw, ih, { x, y, width: w, height: h }, el.imageFit ?? 'cover', el.imageZoom, el.imageFocusX, el.imageFocusY);
      const { x: dx, y: dy, width: dw, height: dh } = crop;
      ctx.globalAlpha = el.fillOpacity ?? 1;
      ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
      ctx.restore();
      if (el.borderWidth && el.borderColor) {
        ctx.globalAlpha = el.borderOpacity ?? 1;
        ctx.strokeStyle = el.borderColor;
        ctx.lineWidth = el.borderWidth * s;
        setDash(ctx, el.borderStyle, ctx.lineWidth);
        if (el.borderRadius) roundRect(ctx, x, y, w, h, el.borderRadius * s);
        else ctx.rect(x, y, w, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      break;
    }

    case 'icon': {
      const img = el.iconId ? rc.icons[el.iconId] : undefined;
      if (!img) { rc.diagnostics?.push({ elementId: el.id, message: `找不到图标 ${el.iconId || ''}` }); break; }
      const [dx, dy, dw, dh] = fitRect(
        'width' in img ? img.width : 0, 'height' in img ? img.height : 0,
        x, y, w, h, 'contain',
      );
      ctx.globalAlpha = el.textOpacity ?? 1;
      // 用离屏画布着色：先画图形，再用 source-in 覆盖颜色
      if (el.color && el.color !== 'transparent' && typeof OffscreenCanvas !== 'undefined') {
        const off = new OffscreenCanvas(Math.max(1, Math.ceil(dw)), Math.max(1, Math.ceil(dh)));
        const o = off.getContext('2d');
        if (o) {
          o.drawImage(img as CanvasImageSource, 0, 0, dw, dh);
          o.globalCompositeOperation = 'source-in';
          o.fillStyle = el.color;
          o.fillRect(0, 0, dw, dh);
          ctx.drawImage(off as unknown as CanvasImageSource, dx, dy);
          ctx.globalAlpha = 1;
          break;
        }
      }
      ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
      break;
    }

    case 'text':
    default: {
      const raw = el.fieldId ? String(rc.values?.[el.fieldId] ?? '') : (el.text ?? '');
      const content = interpolate(raw, rc.values ?? {});
      if (!content) break;

      const text = layoutText(ctx, content, el, s);
      if (text.overflow) rc.diagnostics?.push({ elementId: el.id, message: el.autoFit ? '已缩至最小字号仍溢出' : '文字超出文本框' });
      let top = y + (el.verticalAlign === 'middle' ? (h - text.height) / 2 : el.verticalAlign === 'bottom' ? h - text.height : 0);
      ctx.textBaseline = 'top'; ctx.globalAlpha = el.textOpacity ?? 1;
      for (const line of text.lines) {
        const left = x + (el.horizontalAlign === 'center' ? (w - line.width) / 2 : el.horizontalAlign === 'right' ? w - line.width : 0);
        for (const run of line.runs) {
          ctx.font = run.font;
          ctx.fillStyle = run.color || el.color || '#000';
          const rx = left + run.x, ry = top + (line.height - run.size) / 2;
          if (run.kind !== 'text') {
            const image = run.kind === 'icon' ? rc.icons[run.key!] : rc.images[run.key!];
            if (image) ctx.drawImage(image as CanvasImageSource, rx, ry, run.size, run.size);
            else { ctx.strokeRect(rx, ry, run.size, run.size); rc.diagnostics?.push({ elementId: el.id, message: `缺少行内素材 ${run.key}` }); }
          } else {
            const paint = (value: string, px: number) => {
              if (el.borderWidth && el.borderColor) { ctx.lineWidth = el.borderWidth * s; ctx.strokeStyle = el.borderColor; ctx.lineJoin = 'round'; ctx.strokeText(value, px, ry); }
              ctx.fillText(value, px, ry);
            };
            if (el.letterSpacing) { let px = rx; for (const ch of run.text) { paint(ch, px); px += ctx.measureText(ch).width + el.letterSpacing * s; } }
            else paint(run.text, rx);
          }
        }
        top += line.height;
      }
      break;
    }
  }

  if (rc.outline) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(37,99,235,.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  ctx.restore();
  void fields;
}

/** 数量展开：把「费用=3」渲染成 3 个重复图标 */
function expandCount(el: LayoutElement, values: Record<string, unknown>): LayoutElement[] {
  if (!el.countFieldId) return [el];
  const n = Math.min(el.countMax ?? 20, Math.max(0, Math.round(Number(values?.[el.countFieldId] ?? 0))));
  if (n <= 1) return n === 1 ? [el] : [];
  const gap = el.countSpacing ?? 0;
  const dir = el.countDirection ?? 'horizontal';
  const out: LayoutElement[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...el,
      x: dir === 'horizontal' ? el.x + (el.width + gap) * i : el.x,
      y: dir === 'vertical' ? el.y + (el.height + gap) * i : el.y,
    });
  }
  return out;
}

export interface RenderOptions extends RenderContext {
  /** 打印 / 导出时把整张牌外扩的出血（px，已按 scale 换算前） */
  bleed?: number;
}

export function renderLayout(
  ctx: AnyCtx,
  layout: Layout,
  card: Card | null,
  opts: RenderOptions,
  fields: Field[] = [],
): void {
  const s = opts.scale;
  const values = card?.values ?? opts.values ?? {};
  const bleed = (opts.bleed ?? 0) * s;
  const W = layout.width * s + bleed * 2;
  const H = layout.height * s + bleed * 2;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  // 背景
  ctx.fillStyle = layout.backgroundColor || '#ffffff';
  if (bleed) {
    ctx.fillRect(0, 0, W, H);
    ctx.translate(bleed, bleed);
  } else {
    ctx.fillRect(0, 0, layout.width * s, layout.height * s);
  }

  // 背景图
  if (layout.backgroundAssetId && opts.images[layout.backgroundAssetId]) {
    const img = opts.images[layout.backgroundAssetId];
    const [dx, dy, dw, dh] = fitRect(
      'width' in img ? img.width : 0, 'height' in img ? img.height : 0,
      0, 0, layout.width * s, layout.height * s, 'cover',
    );
    ctx.drawImage(img as CanvasImageSource, dx, dy, dw, dh);
  }

  // 圆角裁切
  if (layout.borderRadius) {
    roundRect(ctx, 0, 0, layout.width * s, layout.height * s, layout.borderRadius * s);
    ctx.clip();
  }

  for (const source of layout.elements) {
    const el = { ...source, ...(card?.layoutOverrides?.[source.id] || {}), id: source.id, kind: source.kind };
    if (el.kind === 'image' && el.fieldId) el.assetId = String(values[el.fieldId] || el.assetId || '');
    if (el.kind === 'icon' && el.fieldId) {
      const option = fields.find((f) => f.id === el.fieldId)?.optionIcons?.[String(values[el.fieldId] ?? '')];
      if (option) { el.iconId = option.id; el.color = option.color; }
    }
    if (!el.hidden && (el.x < 0 || el.y < 0 || el.x + el.width > layout.width || el.y + el.height > layout.height)) opts.diagnostics?.push({ elementId: el.id, message: '元素超出裁切边界' });
    if (!evaluate(el.displayCondition, values)) continue;
    for (const inst of expandCount(el, values)) {
      drawElement(ctx, inst, { ...opts, values }, fields);
    }
  }

  // 卡牌边框
  if (layout.borderWidth && layout.borderColor) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = layout.borderColor;
    ctx.lineWidth = layout.borderWidth * 2 * s; // 内描边，视觉宽度 ×2
    if (layout.borderRadius) roundRect(ctx, 0, 0, layout.width * s, layout.height * s, layout.borderRadius * s);
    else ctx.rect(0, 0, layout.width * s, layout.height * s);
    ctx.stroke();
  }

  ctx.restore();
}

/** 渲染成独立画布（主线程用） */
export function renderToCanvas(
  layout: Layout, card: Card | null, opts: RenderOptions, fields: Field[] = [],
): HTMLCanvasElement {
  const bleed = (opts.bleed ?? 0) * opts.scale;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(layout.width * opts.scale + bleed * 2));
  cv.height = Math.max(1, Math.round(layout.height * opts.scale + bleed * 2));
  const ctx = cv.getContext('2d');
  if (ctx) renderLayout(ctx, layout, card, opts, fields);
  return cv;
}
