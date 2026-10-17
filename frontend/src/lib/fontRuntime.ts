import { fontFamily } from './fontIdentity';
export interface FontSource { id: string; url: string }
const loaded = new Map<string, Promise<void>>();
export async function loadFontSources(sources: FontSource[]): Promise<void> {
  await Promise.all(sources.map(({ id, url }) => {
    const key = `${id}:${url}`;
    if (!loaded.has(key)) {
      const task = (async () => {
        if (typeof FontFace === 'undefined') throw new Error('当前环境不支持自定义字体');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`字体文件读取失败（${response.status}）`);
        const face = new FontFace(fontFamily(id), await response.arrayBuffer());
        await face.load();
        const fontSet = typeof document !== 'undefined' ? document.fonts : (globalThis as unknown as { fonts: FontFaceSet }).fonts;
        if (!fontSet) throw new Error('当前渲染环境不支持加载字体');
        fontSet.add(face);
      })().catch((error) => { loaded.delete(key); throw error; });
      loaded.set(key, task);
    }
    return loaded.get(key)!;
  }));
}
