import type { LayoutElement } from './types';
import { fontCss } from './presets';
export interface TextRun { text: string; kind: 'text' | 'icon' | 'image'; key?: string; bold: boolean; italic: boolean; color?: string; factor: number }
export interface PlacedRun extends TextRun { x: number; width: number; size: number; font: string }
export interface TextLine { runs: PlacedRun[]; width: number; height: number }
export function parseTextRuns(raw: string, rich: boolean, baseSize = 24): TextRun[] {
  const runs: TextRun[] = [];
  let bold = false, italic = false;
  const colors: string[] = [], sizes: number[] = [];
  const push = (text: string, kind: TextRun['kind'] = 'text', key?: string) => { if (text || kind !== 'text') runs.push({ text, kind, key, bold, italic, color: colors.at(-1), factor: sizes.at(-1) ?? 1 }); };
  if (!rich) { push(raw); return runs; }
  const pattern = /\*\*|\*|\[(icon|image):([^\]\r\n]+)\]|\[color=(#[a-fA-F0-9]{6})\]|\[\/color\]|\[size=(\d+(?:\.\d+)?)\]|\[\/size\]/g;
  let last = 0;
  for (const m of raw.matchAll(pattern)) {
    push(raw.slice(last, m.index)); last = m.index! + m[0].length;
    if (m[0] === '**') bold = !bold;
    else if (m[0] === '*') italic = !italic;
    else if (m[1]) push('', m[1] as 'icon' | 'image', m[2].trim());
    else if (m[3]) colors.push(m[3]);
    else if (m[0] === '[/color]') colors.pop();
    else if (m[4]) sizes.push(Math.max(4, Math.min(300, Number(m[4]))) / Math.max(1, baseSize));
    else sizes.pop();
  }
  push(raw.slice(last));
  return runs;
}
export function inlineReferences(raw: string) {
  return [...raw.matchAll(/\[(icon|image):([^\]\r\n]+)\]/g)].map((m) => ({ kind: m[1], id: m[2].trim() }));
}
type Measure = { font: string; measureText: (s: string) => { width: number } };
export function layoutText(ctx: Measure, raw: string, element: LayoutElement, scale = 1): { lines: TextLine[]; size: number; height: number; overflow: boolean } {
  const source = parseTextRuns(raw.replace(/\r\n?/g, '\n'), !!element.richText, element.fontSize || 24);
  const boxWidth = element.width * scale, boxHeight = element.height * scale;
  const letterSpacing = (element.letterSpacing || 0) * scale;
  const atSize = (size: number) => {
    const lines: TextLine[] = [];
    let line: TextLine = { runs: [], width: 0, height: size * (element.lineHeight || 1.25) };
    const newline = () => { lines.push(line); line = { runs: [], width: 0, height: size * (element.lineHeight || 1.25) }; };
    const append = (run: TextRun, text: string) => {
      const fontSize = size * run.factor;
      const font = `${run.italic || element.fontStyle === 'italic' ? 'italic' : 'normal'} ${run.bold || element.fontWeight === 'bold' ? 'bold' : 'normal'} ${fontSize}px ${fontCss(element.fontFamily)}`;
      ctx.font = font;
      const width = run.kind === 'text' ? ctx.measureText(text).width + Math.max(0, [...text].length - 1) * letterSpacing : fontSize;
      if (element.wrapMode !== 'none' && line.runs.length && line.width + letterSpacing + width > boxWidth + 0.1) newline();
      if (element.wrapMode !== 'none' && run.kind === 'text' && width > boxWidth && [...text].length > 1) {
        for (const ch of text) append(run, ch);
        return;
      }
      if (line.runs.length) line.width += letterSpacing;
      line.runs.push({ ...run, text, size: fontSize, font, x: line.width, width });
      line.width += width;
      line.height = Math.max(line.height, fontSize * (element.lineHeight || 1.25));
    };
    for (const run of source) {
      if (run.kind !== 'text') { append(run, ''); continue; }
      const parts = element.wrapMode === 'anywhere' ? [...run.text] : run.text.match(/\n|[^\S\n]+|[A-Za-z0-9_'’\-]+|[^\x00-\x7F]|./gu) || [];
      for (const part of parts) { if (part === '\n') newline(); else append(run, part); }
    }
    lines.push(line);
    const height = lines.reduce((n, l) => n + l.height, 0);
    return { lines, height, size, overflow: height > boxHeight + 0.5 || lines.some((l) => l.width > boxWidth + 0.5) };
  };
  if (!element.autoFit) return atSize((element.fontSize || 24) * scale);
  const min = Math.max(1, (element.minFontSize || 8) * scale);
  const max = Math.max(min, (element.maxFontSize || element.fontSize || 24) * scale);
  let best = atSize(min); if (best.overflow) return best;
  let low = min, high = max;
  for (let i = 0; i < 18; i++) {
    const candidate = atSize((low + high) / 2);
    if (candidate.overflow) high = candidate.size; else { low = candidate.size; best = candidate; }
  }
  return best;
}
