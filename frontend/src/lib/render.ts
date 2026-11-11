import { resolveDesignLayout } from './designSystem';
import {layoutVertical} from './verticalText';
/**
 * 卡牌渲染核心。纯 Canvas 2D 实现，主线程与 Web Worker 共用同一套代码，
 * 因此导出 / 打印 / 编辑器预览在任何地方都能得到完全一致的画面。
 */
import type { AnyCondition, Card, Condition, Field, Layout, LayoutElement } from './types';
import { layoutText } from './textLayout';
import { cropRect } from './editorGeometry';

export type ImageLike = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export interface RenderContext {
  pixelDpiX?:number; pixelDpiY?:number;
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
  /**
   * 空的图片元素画成可见的占位框（编辑器用）。
   * 导出 / 打印不传，免得把占位框印到成品上。
   */
  placeholders?: boolean;
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

/**
 * 空插图框的占位：浅底 + 虚线边 + 对角交叉 + 图标。
 *
 * 之前缺图时这个 case 直接 break，元素在画布上完全隐形——
 * 用户插入「插图框」后看不见任何东西，会以为功能坏了。
 * 只由编辑器传入 placeholders 开启，导出 / 打印不受影响。
 */
function drawImagePlaceholder(
  ctx: AnyCtx, x: number, y: number, w: number, h: number, s: number, el: LayoutElement,
): void {
  ctx.save();
  // 底色：直接用元素的 fill，让占位看起来就是这块区域本身
  ctx.globalAlpha = (el.fillOpacity ?? 1) * 0.55;
  ctx.fillStyle = el.fill && el.fill !== 'transparent' ? el.fill : '#eef1f6';
  ctx.beginPath();
  if (el.borderRadius) roundRect(ctx, x, y, w, h, el.borderRadius * s);
  else {ctx.beginPath();ctx.rect(x, y, w, h);}
  ctx.fill();
  ctx.globalAlpha = 1;

  // 虚线边框
  ctx.strokeStyle = el.borderWidth && el.borderColor ? el.borderColor : '#9aa1ab';
  ctx.lineWidth = Math.max(1, (el.borderWidth ?? 2) * s);
  ctx.setLineDash([6 * s, 5 * s]);
  ctx.beginPath();
  if (el.borderRadius) roundRect(ctx, x, y, w, h, el.borderRadius * s);
  else {ctx.beginPath();ctx.rect(x, y, w, h);}
  ctx.stroke();
  ctx.setLineDash([]);

  // 对角交叉
  ctx.strokeStyle = '#9aa1ab';
  ctx.lineWidth = Math.max(0.6, 1 * s);
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 文字提示：小框里只画图标，放不下就不画字
  const unit = Math.min(w, h);
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cxp = x + w / 2, cyp = y + h / 2;
  if (unit * s > 34) {
    ctx.font = `${Math.round(unit * s * 0.34)}px system-ui, sans-serif`;
    ctx.fillText('🖼', cxp, cyp - (unit * s > 66 ? unit * s * 0.13 : 0));
  }
  if (unit * s > 66) {
    ctx.font = `${Math.round(Math.min(16 * s, unit * s * 0.13))}px system-ui, sans-serif`;
    ctx.fillText(el.fieldId ? '等待卡牌填图' : '未选图片', cxp, cyp + unit * s * 0.18);
  }
  ctx.restore();
}

function drawElement(
  ctx: AnyCtx, el: LayoutElement, rc: RenderContext, fields: Field[],
): void {
  if (el.hidden) return;
  const s = rc.scale;
  const x = el.x * s, y = el.y * s, w = el.width * s, h = el.height * s;

  ctx.save();
  ctx.globalAlpha = 1;
  if(el.blendMode)ctx.globalCompositeOperation=el.blendMode;
  if(el.shadow){ctx.shadowColor=el.shadow.color;ctx.shadowBlur=el.shadow.blur*s;ctx.shadowOffsetX=el.shadow.x*s;ctx.shadowOffsetY=el.shadow.y*s;}
  const paintFill=()=>{
    if(el.textureAssetId){
      const image=rc.images[el.textureAssetId];
      if(image&&typeof DOMMatrix!=='undefined'){
        const pattern=ctx.createPattern(image as CanvasImageSource,'repeat');
        if(pattern){
          const iw=Number(image.width)||1,ih=Number(image.height)||1;
          const [ox,oy,pw,ph]=el.shapePath?(el.pathViewBox??[0,0,100,100]):[x,y,w,h];
          const cover=Math.max(pw/iw,ph/ih),factor=Math.max(.01,el.textureScale??1);
          const sx=el.textureMode==='repeat'?factor*(el.shapePath?pw/w:1)*s:cover*factor;
          const sy=el.textureMode==='repeat'?factor*(el.shapePath?ph/h:1)*s:cover*factor;
          pattern.setTransform(new DOMMatrix([sx,0,0,sy,ox+(pw-iw*sx)/2,oy+(ph-ih*sy)/2]));
          return pattern;
        }
      }
      if(!image)rc.diagnostics?.push({elementId:el.id,message:'缺少纹理素材'});
    }
    if(el.gradient){const a=el.gradient.angle*Math.PI/180,dx=Math.cos(a)*w/2,dy=Math.sin(a)*h/2;const g=ctx.createLinearGradient(x+w/2-dx,y+h/2-dy,x+w/2+dx,y+h/2+dy);g.addColorStop(0,el.gradient.from);g.addColorStop(1,el.gradient.to);return g;}
    return el.fill;
  };

  // 旋转围绕元素中心
  if (el.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((el.rotation * Math.PI) / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }

  switch (el.kind) {
    case 'rectangle':
    case 'path':
    case 'ellipse': {
      const bw = (el.borderWidth ?? 0) * s;
      if(el.kind==='path'&&!el.shapePath)break;
      if(el.shapePath && typeof Path2D !== 'undefined') {
        let path:Path2D;
        try{path=new Path2D(el.shapePath);}catch{rc.diagnostics?.push({elementId:el.id,message:'矢量路径无效'});break;}
        const shapeFill=paintFill();
        const [vx,vy,vw,vh]=el.pathViewBox??[0,0,100,100];
        if(vw<=0||vh<=0)break;
        ctx.translate(x,y);ctx.scale(w/vw,h/vh);ctx.translate(-vx,-vy);
        if(el.textureAssetId||(el.fill && el.fill!=='transparent')){ctx.globalAlpha=el.fillOpacity??1;ctx.fillStyle=shapeFill;ctx.fill(path);}
        if(bw>0 && el.borderColor){ctx.globalAlpha=el.borderOpacity??1;ctx.strokeStyle=el.borderColor;ctx.lineWidth=bw/Math.min(w/vw,h/vh);setDash(ctx,el.borderStyle,ctx.lineWidth);ctx.stroke(path);ctx.setLineDash([]);}
        break;
      }
      if ((el.textureAssetId || (el.fill && el.fill !== 'transparent')) && (el.fillOpacity ?? 1) > 0) {
        ctx.globalAlpha = el.fillOpacity ?? 1;
        ctx.fillStyle = paintFill();
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
          else {ctx.beginPath();ctx.rect(x + bw / 2, y + bw / 2, w - bw, h - bw);}
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
      if (!img) {
        rc.diagnostics?.push({ elementId: el.id, message: el.assetId ? `找不到图片素材 ${el.assetId}` : '插图框还没选图' });
        // 编辑器传 placeholders:true；导出/打印不传，免得把占位框印到成品上
        if (rc.placeholders) drawImagePlaceholder(ctx, x, y, w, h, s, el);
        break;
      }
      ctx.save();
      if(el.maskPath&&typeof Path2D!=='undefined'){
        try{const path=new Path2D(el.maskPath);ctx.translate(x,y);ctx.scale(w/100,h/100);ctx.clip(path);ctx.scale(100/w,100/h);ctx.translate(-x,-y);}catch{rc.diagnostics?.push({elementId:el.id,message:'自定义蒙版路径无效'});}
      } else if(el.imageMask==='ellipse'){ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);ctx.clip();}
      else if (el.borderRadius) {
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
      const dpi=Math.min(iw/Math.max(1,dw/s)*(rc.pixelDpiX??300),ih/Math.max(1,dh/s)*(rc.pixelDpiY??300));
      if(dpi<150)rc.diagnostics?.push({elementId:el.id,message:`图片有效分辨率约 ${Math.round(dpi)} DPI，建议至少 150 DPI`});
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
      if(el.writingMode&&el.writingMode!=='horizontal'){
        const vertical=layoutVertical(content,el,s);
        if(vertical.overflow)rc.diagnostics?.push({elementId:el.id,message:'竖排文字超出文本框'});
        ctx.textBaseline='top';ctx.textAlign='left';ctx.globalAlpha=el.textOpacity??1;
        for(const g of vertical.glyphs){const gx=x+g.x,gy=y+g.y;
          if(g.kind!=='text'){const image=g.kind==='icon'?rc.icons[g.key!]:rc.images[g.key!];if(image)ctx.drawImage(image as CanvasImageSource,gx,gy,g.size,g.size);continue;}
          ctx.font=g.font;ctx.fillStyle=g.color||el.color||'#000';
          if(el.borderWidth&&el.borderColor){ctx.strokeStyle=el.borderColor;ctx.lineWidth=el.borderWidth*s;ctx.lineJoin='round';ctx.strokeText(g.text,gx,gy);}
          ctx.fillText(g.text,gx,gy);
        }break;
      }

      const text = layoutText(ctx, content, el, s);
      if (text.overflow) rc.diagnostics?.push({ elementId: el.id, message: el.autoFit ? '已缩至最小字号仍溢出' : '文字超出文本框' });
      const padding=(el.padding??0)*s, innerW=Math.max(1,w-padding*2),innerH=Math.max(1,h-padding*2);
      let top = y+padding + (el.verticalAlign === 'middle' ? (innerH - text.height) / 2 : el.verticalAlign === 'bottom' ? innerH - text.height : 0);
      if(el.autoFit&&text.size/s<(el.fontSize??24)*.75)rc.diagnostics?.push({elementId:el.id,message:'文字自动缩小超过 25%，建议调整版式'});
      if(text.size/s/(rc.pixelDpiY??300)*72<6)rc.diagnostics?.push({elementId:el.id,message:'字号低于 6pt，请按实际印刷尺寸检查可读性'});
      ctx.textBaseline = 'top'; ctx.globalAlpha = el.textOpacity ?? 1;
      for (const line of text.lines) {
        const left = x+padding + (el.horizontalAlign === 'center' ? (innerW - line.width) / 2 : el.horizontalAlign === 'right' ? innerW - line.width : 0);
        for (const run of line.runs) {
          ctx.font = run.font;
          ctx.fillStyle = el.gradient?paintFill():(run.color || el.color || '#000');
          const rx = left + run.x, ry = top + (line.height - run.size) / 2+(run.kind==='text'?0:(el.inlineIconOffset??0)*s);
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
        top += line.height+(line.gapAfter??0);
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
export function expandCount(el: LayoutElement, values: Record<string, unknown>): Array<LayoutElement & {slotFraction?:number}> {
  if (!el.countFieldId) return [el];
  const raw=Number(values?.[el.countFieldId]??0),limit=Math.max(1,Math.min(100,Math.floor(el.countMax??20)));
  const amount=Math.min(limit,Math.max(0,Number.isFinite(raw)?raw:0));
  const filled=el.countHalf?Math.round(amount*2)/2:Math.round(amount);
  const dynamic=el.countSlotsFieldId?Number(values[el.countSlotsFieldId]):undefined;
  const slots=dynamic===undefined?el.countSlots:Number.isFinite(dynamic)?Math.max(0,Math.floor(dynamic)):0;
  const n=slots!==undefined?Math.max(0,Math.min(limit,Math.floor(slots))):Math.ceil(filled);
  const gap = el.countSpacing ?? 0;
  const dir = el.countDirection ?? 'horizontal';
  const out: Array<LayoutElement & {slotFraction?:number}> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...el,
      slotFraction:Math.max(0,Math.min(1,filled-i)),
      x: dir === 'horizontal' ? el.x + (el.width + gap) * i : el.x,
      y: dir === 'vertical' ? el.y + (el.height + gap) * i : el.y,
    });
  }
  return out;
}

export interface RenderOptions extends RenderContext {
  /** 编辑器暂存区；导出不传此参数。 */
  workspacePadding?: number;
  /** 打印 / 导出时把整张牌外扩的出血（px，已按 scale 换算前） */
  bleed?: number;
}

export function resolveCardDesign(ctx: Pick<CanvasRenderingContext2D,'font'|'measureText'>,layout:Layout,values:Record<string,unknown>={}):Layout {
  return resolveDesignLayout(layout,el=>layoutText(ctx,interpolate(el.fieldId?String(values[el.fieldId]??''):el.text??'',values),{...el,autoFit:false,height:100000},1).height+2*(el.padding??0));
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
  layout=resolveCardDesign(ctx,layout,values);
  const bleed = (opts.bleed ?? 0) * s;
  const W = layout.width * s + bleed * 2;
  const H = layout.height * s + bleed * 2;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const workspace=(opts.workspacePadding??0)*s;
  if(workspace){ctx.clearRect(0,0,W+workspace*2,H+workspace*2);ctx.translate(workspace,workspace);}

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
  if (layout.borderRadius && !workspace) {
    roundRect(ctx, 0, 0, layout.width * s, layout.height * s, layout.borderRadius * s);
    ctx.clip();
  }

  for (const source of layout.elements) {
    if(layout.elements.some(e=>e.clipSourceId===source.id))continue;
    const el = { ...source, ...(card?.layoutOverrides?.[source.id] || {}), id: source.id, kind: source.kind };
    if (el.kind === 'image' && el.fieldId) el.assetId = String(values[el.fieldId] || el.assetId || '');
    if (el.kind === 'icon' && el.fieldId) {
      const option = fields.find((f) => f.id === el.fieldId)?.optionIcons?.[String(values[el.fieldId] ?? '')];
      if (option) { el.iconId = option.id; el.color = option.color; }
    }
    if (!el.hidden && (el.x < 0 || el.y < 0 || el.x + el.width > layout.width || el.y + el.height > layout.height)) opts.diagnostics?.push({ elementId: el.id, message: '元素超出裁切边界' });
    if (!evaluate(el.displayCondition, values)) continue;
    for (const inst of expandCount(el, values)) {
      const mask=el.clipSourceId?layout.elements.find(e=>e.id===el.clipSourceId):undefined;
      if(el.clipSourceId&&!mask){opts.diagnostics?.push({elementId:el.id,message:'缺少剪切源'});continue;}
      ctx.save();
      if(mask){
        if(mask.width<=0||mask.height<=0){ctx.restore();continue;}
        const mx=mask.x*s,my=mask.y*s,mw=mask.width*s,mh=mask.height*s,a=mask.rotation*Math.PI/180;
        ctx.translate(mx+mw/2,my+mh/2);ctx.rotate(a);ctx.translate(-mw/2,-mh/2);
        if(mask.shapePath){
          const [vx,vy,vw,vh]=mask.pathViewBox??[0,0,100,100];
          if(vw<=0||vh<=0){ctx.restore();continue;}
          try{const path=new Path2D(mask.shapePath);ctx.scale(mw/vw,mh/vh);ctx.translate(-vx,-vy);ctx.clip(path);ctx.translate(vx,vy);ctx.scale(vw/mw,vh/mh);}catch{ctx.restore();opts.diagnostics?.push({elementId:mask.id,message:'剪切路径无效'});continue;}
        }else{ctx.beginPath();if(mask.kind==='ellipse')ctx.ellipse(mw/2,mh/2,mw/2,mh/2,0,0,Math.PI*2);else if(mask.borderRadius)roundRect(ctx,0,0,mw,mh,mask.borderRadius*s);else ctx.rect(0,0,mw,mh);ctx.clip();}
        ctx.translate(mw/2,mh/2);ctx.rotate(-a);ctx.translate(-mx-mw/2,-my-mh/2);
      }
      const draw=()=>drawElement(ctx, inst, { ...opts, values, pixelDpiX:layout.width/(layout.widthMm??63.5)*25.4,pixelDpiY:layout.height/(layout.heightMm??88.9)*25.4 }, fields);
      if(inst.slotFraction!==undefined&&inst.slotFraction<1){
        ctx.save();ctx.filter=`grayscale(1) opacity(${Math.max(0,Math.min(1,el.countEmptyOpacity??.2))})`;draw();ctx.restore();
        if(inst.slotFraction>0){ctx.save();const cx=(inst.x+inst.width/2)*s,cy=(inst.y+inst.height/2)*s,a=inst.rotation*Math.PI/180;ctx.translate(cx,cy);ctx.rotate(a);ctx.beginPath();ctx.rect(-inst.width*s/2,-inst.height*s/2,inst.width*s*inst.slotFraction,inst.height*s);ctx.clip();ctx.rotate(-a);ctx.translate(-cx,-cy);draw();ctx.restore();}
      }else draw();
      ctx.restore();
    }
  }

  // 卡牌边框
  if (layout.borderWidth && layout.borderColor) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = layout.borderColor;
    ctx.lineWidth = layout.borderWidth * 2 * s; // 内描边，视觉宽度 ×2
    if (layout.borderRadius) roundRect(ctx, 0, 0, layout.width * s, layout.height * s, layout.borderRadius * s);
    else {ctx.beginPath();ctx.rect(0, 0, layout.width * s, layout.height * s);}
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
  const padding=(opts.workspacePadding??0)*opts.scale;
  cv.width = Math.max(1, Math.round(layout.width * opts.scale + bleed * 2 + padding*2));
  cv.height = Math.max(1, Math.round(layout.height * opts.scale + bleed * 2 + padding*2));
  const ctx = cv.getContext('2d');
  if (ctx) renderLayout(ctx, layout, card, opts, fields);
  return cv;
}
