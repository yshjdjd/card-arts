import { fontAssetId, fontFamily } from './fontIdentity';
/** 卡牌尺寸预设。px 按 300 DPI 换算，mm 为物理尺寸（导出 / 打印用）。 */

export interface SizePreset {
  key: string;
  name: string;
  nameEn: string;
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
}

export const CARD_PRESETS: SizePreset[] = [
  { key: 'poker', name: '扑克牌', nameEn: 'Poker', width: 750, height: 1050, widthMm: 63.5, heightMm: 88.9 },
  { key: 'bridge', name: '桥牌', nameEn: 'Bridge', width: 675, height: 1050, widthMm: 57.2, heightMm: 88.9 },
  { key: 'tarot', name: '塔罗牌', nameEn: 'Tarot', width: 825, height: 1425, widthMm: 69.9, heightMm: 120.7 },
  { key: 'mini', name: '迷你美式', nameEn: 'Mini American', width: 488, height: 750, widthMm: 41.3, heightMm: 63.5 },
  { key: 'euro', name: '欧式', nameEn: 'Euro', width: 697, height: 1087, widthMm: 59, heightMm: 92 },
  { key: 'square', name: '方形卡牌', nameEn: 'Square', width: 825, height: 825, widthMm: 69.9, heightMm: 69.9 },
];

export function presetByKey(key: string): SizePreset | undefined {
  return CARD_PRESETS.find((p) => p.key === key);
}

/** 反查：给定 px 尺寸，尽量匹配一个预设（导入旧工程时有用） */
export function matchPreset(w: number, h: number): SizePreset | undefined {
  return CARD_PRESETS.find((p) => Math.abs(p.width - w) <= 2 && Math.abs(p.height - h) <= 2);
}

export const FONTS: { key: string; name: string; css: string }[] = [
  { key: 'sans', name: '无衬线（默认）', css: '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif' },
  { key: 'serif', name: '衬线', css: '"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif' },
  { key: 'mono', name: '等宽', css: '"JetBrains Mono",Consolas,"Courier New",monospace' },
  { key: 'rounded', name: '圆体', css: '"Hiragino Maru Gothic ProN","Yuanti SC","Quicksand",system-ui,sans-serif' },
  { key: 'black', name: '黑体加粗', css: '"Source Han Sans Heavy","Microsoft YaHei",system-ui,sans-serif' },
];

export function fontCss(key: string | undefined): string {
  const id = fontAssetId(key);
  return id ? `"${fontFamily(id)}",${FONTS[0].css}` : (FONTS.find((f) => f.key === key) ?? FONTS[0]).css;
}

/** 默认牌面配色方案 */
export const PALETTES: { name: string; colors: string[] }[] = [
  { name: '经典', colors: ['#ffffff', '#1f2937', '#dc2626', '#2563eb', '#16a34a', '#f59e0b'] },
  { name: '柔和', colors: ['#fdf6e3', '#586e75', '#cb4b16', '#268bd2', '#859900', '#d33682'] },
  { name: '暗夜', colors: ['#111827', '#f9fafb', '#f472b6', '#60a5fa', '#34d399', '#fbbf24'] },
  { name: '大地', colors: ['#faf3e0', '#4a3f35', '#c1666b', '#7d9d9c', '#a68a64', '#e0a96d'] },
];
