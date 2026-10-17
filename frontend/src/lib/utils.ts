export const uid = (): string =>
  (crypto as any).randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export const shortId = () => uid().slice(0, 8);

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function deepClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** 下载 JSON，带 BOM 友好性由调用方决定 */
export function downloadJSON(data: unknown, filename: string): void {
  downloadText(JSON.stringify(data, null, 2), filename, 'application/json;charset=utf-8');
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDate(iso: string | number | Date | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 文件名安全化 */
export function safeName(s: string): string {
  return (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'unnamed';
}

/** 数组移动，用于图层 / 字段排序 */
export function move<T>(arr: T[], from: number, to: number): T[] {
  const a = arr.slice();
  if (from < 0 || from >= a.length || to < 0 || to >= a.length) return a;
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

export function classNames(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

/** 极简防抖 */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 300) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** hex 颜色明暗调整，用于生成 UI 强调色 */
export function shade(hex: string, pct: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const f = (n: number) => clamp(Math.round(n + 255 * pct), 0, 255).toString(16).padStart(2, '0');
  return `#${f(parseInt(m[1], 16))}${f(parseInt(m[2], 16))}${f(parseInt(m[3], 16))}`;
}

export function isHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}
