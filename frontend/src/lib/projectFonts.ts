import { assetUrl, type RemoteAssetDTO } from '../api/client';
import { db } from '../db/schema';
import type { Layout } from './types';
import { fontAssetId, fontMime, validFontHeader } from './fontIdentity';
import type { FontSource } from './fontRuntime';
const localUrls = new Map<string, string>();
export async function projectFontSources(layouts: (Layout | null | undefined)[], assets: RemoteAssetDTO[]): Promise<FontSource[]> {
  const ids = new Set(layouts.flatMap((l) => l?.elements.map((e) => fontAssetId(e.fontFamily)).filter((id): id is string => !!id) ?? []));
  return Promise.all([...ids].map(async (id) => {
    const asset = assets.find((a) => a.id === id);
    if (asset?.url) return { id, url: assetUrl(asset.url) };
    const local = await db.assets.get(id) || await db.assets.filter((a) => a.remoteId === id).first();
    if (local?.blob) {
      if (!localUrls.has(id)) localUrls.set(id, URL.createObjectURL(local.blob));
      return { id, url: localUrls.get(id)! };
    }
    throw new Error(`找不到字体素材 ${asset?.name || id}，请在字体库重新添加`);
  }));
}
export async function expandFontFiles(files: File[]): Promise<File[]> {
  const result: File[] = [];
  let size = 0;
  const accept = async (name: string, bytes: ArrayBuffer) => {
    const mime = fontMime(name);
    if (!mime) return;
    size += bytes.byteLength;
    if (size > 128 * 1024 * 1024 || result.length >= 64) throw new Error('一次最多导入 64 个字体，总大小不超过 128 MB');
    if (!validFontHeader(new Uint8Array(bytes))) throw new Error(`不是有效字体文件：${name}`);
    await new FontFace('cardarts_validation', bytes).load();
    result.push(new File([bytes], name.split(/[\\/]/).pop()!, { type: mime }));
  };
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if (file.size > 128 * 1024 * 1024) throw new Error('字体包超过 128 MB');
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !fontMime(entry.name) || /(^|\/)__MACOSX\//.test(entry.name)) continue;
        const advertised = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
        if (size + advertised > 128 * 1024 * 1024 || result.length >= 64) throw new Error('字体包解压后超过导入限制');
        await accept(entry.name, await entry.async('arraybuffer'));
      }
    } else {
      if (!fontMime(file.name)) throw new Error(`不支持的字体格式：${file.name}`);
      await accept(file.name, await file.arrayBuffer());
    }
  }
  if (!result.length) throw new Error('没有找到 TTF、OTF、WOFF 或 WOFF2 字体文件');
  return result;
}
