/** 卡牌数据的表格导入 / 导出（CSV / XLSX / JSON）。 */
import type { Card, Deck, Field } from './types';
import { downloadBlob, downloadText } from './utils';

export function deckToRows(deck: Deck): { header: string[]; rows: unknown[][] } {
  const fields = deck.fields ?? [];
  const header = [...fields.map((f) => f.name), 'count'];
  const rows = (deck.cards ?? []).map((c) => [
    ...fields.map((f) => c.values?.[f.id] ?? ''),
    c.values?.count ?? 1,
  ]);
  return { header, rows };
}

export function toCSV(header: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

export function parseCSV(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cur); cur = '';
    } else if (ch === '\n') {
      row.push(cur); out.push(row); row = []; cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter((r) => r.some((c) => c !== ''));
}

export function exportCSV(deck: Deck, filename: string): void {
  const { header, rows } = deckToRows(deck);
  downloadText(toCSV(header, rows), filename, 'text/csv;charset=utf-8');
}

/** 通用表格导出（不依赖牌组结构，用于表格文档） */
export async function exportTableXLSX(
  sheets: { name: string; header: string[]; rows: unknown[][] }[],
  filename: string,
): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.header, ...s.rows]);
    ws['!cols'] = s.header.map((h) => ({ wch: Math.max(10, String(h).length * 2 + 4) }));
    XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 28));
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

export function exportTableCSV(header: string[], rows: unknown[][], filename: string): void {
  downloadText(toCSV(header, rows), filename, 'text/csv;charset=utf-8');
}

/** 多 sheet 的 xlsx 读取结果摊平成 [{sheet, header, rows}] */
export function flattenSheets(data: Record<string, string[][]>): { name: string; header: string[]; rows: string[][] }[] {
  const out: { name: string; header: string[]; rows: string[][] }[] = [];
  for (const [name, rows0] of Object.entries(data)) {
    const rows = rows0.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
    if (!rows.length) continue;
    const header = rows[0].map((h, i) => String(h ?? '').trim() || `列${i + 1}`);
    const body = rows.slice(1).map((r) => header.map((_, i) => String(r[i] ?? '')));
    out.push({ name, header, rows: body });
  }
  return out;
}

export async function exportXLSX(decks: Deck[], filename: string): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const deck of decks) {
    const { header, rows } = deckToRows(deck);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map((h) => ({ wch: Math.max(10, h.length * 2 + 4) }));
    XLSX.utils.book_append_sheet(wb, ws, deck.name.slice(0, 28));
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

export async function readXLSX(file: File): Promise<Record<string, string[][]>> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const out: Record<string, string[][]> = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    out[name] = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, defval: '' })
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
  }
  return out;
}

/** 表头 -> 字段的匹配（支持中文表头同名，也支持 id） */
export function guessFieldIds(header: string[], fields: Field[]): (string | null)[] {
  return header.map((h) => {
    const k = h.trim();
    const byId = fields.find((f) => f.id === k);
    if (byId) return byId.id;
    const byName = fields.find((f) => f.name === k);
    if (byName) return byName.id;
    return null;
  });
}

export function rowsToCards(
  data: string[][],
  fieldIds: (string | null)[],
  fields: Field[],
  mode: 'append' | 'replace',
  existing: Card[],
): Card[] {
  const body = data.slice(1);
  const cards: Card[] = mode === 'replace' ? [] : existing.slice();
  const uid = () => (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2);
  for (const r of body) {
    if (!r.some((c) => String(c ?? '').trim() !== '')) continue;
    const values: Record<string, unknown> = {};
    fieldIds.forEach((fid, i) => {
      if (!fid) return;
      const f = fields.find((x) => x.id === fid);
      const raw = r[i] ?? '';
      let v: unknown = raw;
      if (f?.type === 'number') v = raw === '' ? '' : Number(raw);
      else if (f?.type === 'boolean') v = raw === 'true' || raw === '1' || raw === '是';
      values[fid] = v;
    });
    if (values.count === '' || values.count === undefined) values.count = 1;
    cards.push({ id: uid(), values });
  }
  return cards;
}
