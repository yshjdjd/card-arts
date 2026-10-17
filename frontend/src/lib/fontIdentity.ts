export const FONT_MIMES: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
export function fontMime(name: string): string | undefined { return FONT_MIMES[name.split('.').pop()?.toLowerCase() || '']; }
export function fontKey(id: string) { return `asset:${id}`; }
export function fontAssetId(key?: string) { return key?.startsWith('asset:') ? key.slice(6) : undefined; }
export function fontFamily(id: string) { return `ca_font_${Array.from(id).map((c) => c.codePointAt(0)!.toString(16)).join('_')}`; }
export function validFontHeader(bytes: Uint8Array) {
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  return magic === 'OTTO' || magic === 'wOFF' || magic === 'wOF2' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
}
