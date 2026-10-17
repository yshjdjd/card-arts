/**
 * 图片链路的自检脚本。
 * 运行：node frontend/test_image_flow.mjs
 *
 * 覆盖三件事（都是真实踩过的坑）：
 *   1. 空插图框在编辑器里必须看得见（否则用户以为插入失效）
 *   2. 同一份渲染代码，导出/打印时不能把占位框印上去
 *   3. 智能体读素材要走服务端清单，不能只读本地表（以前读错了，库里明明有图却看到空）
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 打两个包：渲染层 / 工具层 ---------- */

const builtRender = await esbuild.build({
  stdin: { contents: "export * from './src/lib/render';\n", resolveDir: here, sourcefile: 'r.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const R = await import(`data:text/javascript;base64,${Buffer.from(builtRender.outputFiles[0].text).toString('base64')}`);

/**
 * agentTools 依赖 api/client（浏览器 fetch）和 db/schema（Dexie + IndexedDB），
 * Node 里都没有，打包时换成可控的假实现——顺便能断言「到底读了哪一份数据」。
 */
const fake = {
  assets: [] /* 服务端素材 */,
  localAssets: [] /* 本地未同步素材 */,
  content: { decks: [] } /* 项目内容，工具读的就是它 */,
  calls: [],
};

const stubDeps = {
  name: 'stub-deps',
  setup(build) {
    build.onResolve({ filter: /(api\/client|db\/schema)$/ }, (a) => ({
      path: a.path, namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path.includes('api/client')
        ? [
          'export const API_BASE = "/api/v1";',
          'export function assetUrl(u) { return u; }',
          'export const api = {',
          '  listAssets: async (pid) => { globalThis.__fake.calls.push("api.listAssets"); return { items: globalThis.__fake.assets }; },',
          '  renameAsset: async () => { globalThis.__fake.calls.push("api.renameAsset"); return {}; },',
          '  deleteAsset: async () => { globalThis.__fake.calls.push("api.deleteAsset"); },',
          '  importAssetUrl: async (b) => {',
          '    globalThis.__fake.calls.push("api.importAssetUrl");',
          '    if (!/^https?:\\/\\//i.test(b.url || "")) throw new Error("url 必须是 http(s) 链接");',
          '    return { asset: { id: "newimg", name: b.name || "imported.png", kind: "image", mime: "image/png", size: 10, url: "/x" } };',
          '  },',
          '};',
        ].join('\n')
        : [
          'export const db = {',
          '  projects: { get: async () => ({ id: "p1", remoteId: "srv-p1", content: globalThis.__fake.content }) },',
          '  assets: {',
          '    where: () => ({ equals: () => ({ toArray: async () => globalThis.__fake.localAssets }) }),',
          '    put: async () => {}, delete: async () => {}, update: async () => {},',
          '  },',
          '};',
          'export const defaultFields = () => [];',
          'export const emptyLayout = (n, w, h) => ({ id: "l", name: n, width: w, height: h, widthMm: 63, heightMm: 88, backgroundColor: "#fff", elements: [] });',
          'export const uid = () => "u" + Math.random().toString(36).slice(2, 8);',
        ].join('\n'),
      loader: 'js',
    }));
  },
};

globalThis.__fake = fake;
const builtTools = await esbuild.build({
  stdin: { contents: "export * from './src/lib/agentTools';\n", resolveDir: here, sourcefile: 't.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, plugins: [stubDeps],
});
const T = await import(`data:text/javascript;base64,${Buffer.from(builtTools.outputFiles[0].text).toString('base64')}`);

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

/* ---------- 假 2D 上下文，记录画了什么 ---------- */

function mockCtx() {
  const log = [];
  const rec = (n) => (...a) => log.push([n, ...a]);
  return {
    log,
    save: rec('save'), restore: rec('restore'),
    clearRect: rec('clearRect'), fillRect: rec('fillRect'),
    beginPath: rec('beginPath'), rect: rec('rect'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    arc: rec('arc'), closePath: rec('closePath'), clip: rec('clip'),
    fill: rec('fill'), stroke: rec('stroke'),
    drawImage: rec('drawImage'), fillText: rec('fillText'),
    measureText: () => ({ width: 40 }),
    setLineDash: rec('setLineDash'), translate: rec('translate'), rotate: rec('rotate'),
    scale: rec('scale'),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', globalCompositeOperation: 'source-over',
  };
}

const imgEl = (over = {}) => ({
  id: 'e1', kind: 'image', name: '插图框', x: 50, y: 50, width: 240, height: 240,
  rotation: 0, fill: '#e5e7eb', color: '#111', imageFit: 'cover', ...over,
});
const layoutOf = (els) => ({ id: 'l', name: '正面', width: 750, height: 1050, widthMm: 63, heightMm: 88, backgroundColor: '#fff', elements: els });

/* ---------- 1. 空插图框的占位 ---------- */

console.log('\n[1] 空插图框：编辑器可见、导出不含');
{
  const c = mockCtx();
  const diag = [];
  R.renderLayout(c, layoutOf([imgEl()]), null, { values: {}, images: {}, icons: {}, scale: 1, diagnostics: diag, placeholders: true });
  const names = c.log.map((x) => x[0]);
  ok(names.includes('fill'), '占位会填充底色');
  ok(names.includes('stroke'), '占位会描虚线边框');
  ok(names.includes('fillText'), '占位会写提示文字');
  ok(diag.length === 1 && diag[0].message === '插图框还没选图', '诊断信息清晰', JSON.stringify(diag));
}
{
  const c = mockCtx();
  const diag = [];
  R.renderLayout(c, layoutOf([imgEl({ assetId: 'missing' })]), null, { values: {}, images: {}, icons: {}, scale: 1, diagnostics: diag, placeholders: true });
  ok(diag[0]?.message === '找不到图片素材 missing', '缺素材时区分于「未选图」', diag[0]?.message);
  ok(c.log.some((x) => x[0] === 'fillText'), '缺素材时也画占位，便于发现');
}
{
  const c = mockCtx();
  R.renderLayout(c, layoutOf([imgEl()]), null, { values: {}, images: {}, icons: {}, scale: 1 });
  const after = c.log.filter((x, i) => i > c.log.findIndex((y) => y[0] === 'clearRect')).map((x) => x[0]);
  // 导出路径不传 placeholders：除背景 fillRect 外不应有针对该元素的绘制
  ok(!after.includes('fillText') && !after.includes('stroke'), '导出时不画占位框');
}
{
  const c = mockCtx();
  const img = { width: 600, height: 400 };
  R.renderLayout(c, layoutOf([imgEl({ assetId: 'a1' })]), null, { values: {}, images: { a1: img }, icons: {}, scale: 1 });
  ok(c.log.some((x) => x[0] === 'drawImage'), '有图时正常画图片');
  ok(!c.log.some((x) => x[0] === 'fillText' && String(x[1]).includes('未选')), '有图时不画占位文字');
}

/* ---------- 2. 按字段取图 ---------- */

console.log('\n[2] 插图框绑定图片字段');
{
  const c = mockCtx();
  const img = { width: 400, height: 400 };
  R.renderLayout(c, layoutOf([imgEl({ assetId: 'default', fieldId: 'art' })]),
    { id: 'c1', values: { art: 'cardimg' } },
    { values: {}, images: { cardimg: img, default: { width: 10, height: 10 } }, icons: {}, scale: 1 });
  ok(c.log.some((x) => x[0] === 'drawImage'), '卡片有值时按卡片取图');
}
{
  // 卡片没填 → 回退到元素上的默认图
  const c = mockCtx();
  R.renderLayout(c, layoutOf([imgEl({ assetId: 'default', fieldId: 'art' })]),
    { id: 'c1', values: {} },
    { values: {}, images: { default: { width: 10, height: 10 } }, icons: {}, scale: 1 });
  ok(c.log.some((x) => x[0] === 'drawImage'), '卡片没填时回退到默认图');
}
{
  const c = mockCtx();
  const diag = [];
  R.renderLayout(c, layoutOf([imgEl({ fieldId: 'art' })]), { id: 'c1', values: {} },
    { values: {}, images: {}, icons: {}, scale: 1, diagnostics: diag, placeholders: true });
  ok(diag[0]?.message === '插图框还没选图', '字段和默认图都没有时算未选图', diag[0]?.message);
}

/* ---------- 3. 智能体读素材库 ---------- */

console.log('\n[3] 智能体看到的素材库');
const ctx = {
  projectId: 'p1', projectName: '测试',
  update: async (fn) => { const c = { decks: [] }; fn(c); },
  rename: async () => {},
};

{
  fake.assets = [{ id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 20480, url: '/u/a1' }];
  fake.localAssets = [];
  fake.calls = [];
  const list = await T.listProjectAssets(ctx, { force: true });
  ok(fake.calls.includes('api.listAssets'), '优先读服务端清单（以前只读本地，导致库里有图却看不见）');
  ok(list.length === 1 && list[0].name === '火焰.png', '拿到真实素材', JSON.stringify(list));
}
{
  // 服务端挂了 → 退回本地
  fake.assets = [];
  fake.localAssets = [{ id: 'b1', projectId: 'p1', name: '离线图.png', kind: 'image', mime: 'image/png', size: 1024, state: 'local-only' }];
  const list = await T.listProjectAssets(ctx, { force: true });
  ok(list.some((a) => a.id === 'b1'), '离线时退回本地素材');
}
{
  // 刚上传、还没进服务端清单的也要带上
  fake.assets = [{ id: 'a1', name: '老的.png', kind: 'image', mime: 'image/png', size: 1, url: '/u' }];
  fake.localAssets = [{ id: 'c9', projectId: 'p1', name: '刚传的.png', kind: 'image', mime: 'image/png', size: 1, state: 'local-only' }];
  const list = await T.listProjectAssets(ctx, { force: true });
  ok(list.some((a) => a.id === 'c9'), '刚上传的素材智能体也看得见');
  ok(list.filter((a) => a.id === 'a1').length === 1, '不会重复列出');
}

/* ---------- 4. 素材工具 ---------- */

console.log('\n[4] 素材工具');
{
  fake.assets = [
    { id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 20480, url: '/u/a1' },
    { id: 'a2', name: '衬线体.ttf', kind: 'font', mime: 'font/ttf', size: 40960, url: '/u/a2' },
  ];
  fake.localAssets = [];
  const acts = T.createAgentActions(ctx);

  const all = await acts['asset.list']({});
  ok(all.includes('火焰.png') && all.includes('a1'), 'asset.list 列出图片');
  ok(all.includes('20KB'), '带体积信息', all);

  const only = await acts['asset.list']({ kind: 'font' });
  ok(only.includes('衬线体.ttf') && !only.includes('火焰.png'), 'kind 过滤生效', only);

  const bad = await acts['asset.import']({ url: 'ftp://x/y.png' });
  ok(bad.startsWith('❌') && bad.includes('http'), 'import 拒绝非 http 链接', bad);

  const imported = await acts['asset.import']({ url: 'https://example.com/a.png' });
  ok(imported.startsWith('✅') && imported.includes('newimg'), 'import 返回可直接使用的 id', imported);

  const missing = await acts['asset.use']({ asset: '不存在的图', deck: 'x' });
  ok(missing.startsWith('❌') && missing.includes('找不到素材'), '素材不存在时先报素材错（比留个空框好）', missing);
  ok(missing.includes('火焰.png'), '报错里附上现有素材，方便模型改口', missing);
}
{
  // 项目概览里要出现素材，否则模型压根不知道有图可用
  fake.assets = [{ id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u/a1' }];
  fake.localAssets = [];
  const ov = await T.projectOverview({ ...ctx });
  ok(ov.includes('【素材】'), '项目概览里有素材段');
  ok(ov.includes('火焰.png') && ov.includes('a1'), '概览列出可用图片 id');
}
{
  fake.assets = [];
  fake.localAssets = [];
  T.invalidateAssets('p1'); // 概览走的是带缓存的读取，先让它重新拉一次
  const ov = await T.projectOverview({ ...ctx });
  ok(ov.includes('图 0 个'), '空库时如实告知', ov.slice(-120));
  ok(ov.includes('素材库是空的'), '并说明该怎么拿到图', ov.slice(-120));
}

/* ---------- 5. 卡牌图片字段：名字自动换成 id ---------- */

console.log('\n[5] 图片字段写入');
const baseContent = {
  decks: [{
    id: 'd1', name: '主牌组',
    fields: [{ id: 'name', name: '名称', type: 'text' }, { id: 'art', name: '插图', type: 'image' }],
    cards: [{ id: 'c1', values: { name: '火焰箭' } }],
    frontLayout: { id: 'l', name: '正面', width: 750, height: 1050, widthMm: 63, heightMm: 88, backgroundColor: '#fff', elements: [] },
    backLayout: null,
  }],
};
/** 工具改写的是 db 里的项目内容，所以每个用例都重置一份 */
const withContent = (mutate = (c) => c) => {
  const c = { ...ctx, update: async (fn) => { fn(fake.content); } };
  fake.content = structuredClone(baseContent);
  mutate(fake.content);
  T.invalidateAssets('p1'); // 素材清单刚换过，别读到上一份快照
  return c;
};
{
  fake.assets = [{ id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u' }];
  fake.localAssets = [];
  const acts = T.createAgentActions(withContent());
  const out = await acts['card.set']({ deck: '主牌组', card: '火焰箭', field: '插图', value: '火焰.png' });
  ok(out.startsWith('✅'), '写入成功', out);
  ok(fake.content.decks[0].cards[0].values.art === 'a1', '素材名被换成 id（不然渲染不出图）', fake.content.decks[0].cards[0].values.art);
}
{
  fake.assets = [{ id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u' }];
  const acts = T.createAgentActions(withContent());
  await acts['card.set']({ deck: '主牌组', card: '火焰箭', field: '插图', value: 'a1' });
  ok(fake.content.decks[0].cards[0].values.art === 'a1', '直接给 id 时原样保存');
}
{
  // asset.use 新建插图框
  fake.assets = [{ id: 'a1', name: '火焰.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u' }];
  const acts = T.createAgentActions(withContent());
  const out = await acts['asset.use']({ asset: '火焰.png', deck: '主牌组', side: 'front' });
  ok(out.startsWith('✅') && out.includes('插图框'), 'asset.use 会新建插图框', out);
  const el = fake.content.decks[0].frontLayout.elements?.[0];
  ok(el?.kind === 'image' && el?.assetId === 'a1', '新插图框带上了素材 id', JSON.stringify(el));
}
{
  // 替换已有插图框的图
  fake.assets = [{ id: 'a7', name: '新图.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u' }];
  const acts = T.createAgentActions(withContent((c) => { c.decks[0].frontLayout.elements = [imgEl({ id: 'e1', name: '插图框' })]; }));
  const out = await acts['asset.use']({ asset: '新图.png', deck: '主牌组', element: '插图框' });
  ok(out.startsWith('✅') && out.includes('新图.png'), '替换已有插图框的图', out);
  ok(fake.content.decks[0].frontLayout.elements[0].assetId === 'a7', 'assetId 已更新', fake.content.decks[0].frontLayout.elements[0].assetId);
}
{
  fake.assets = [{ id: 'a7', name: '新图.png', kind: 'image', mime: 'image/png', size: 2048, url: '/u' }];
  const acts = T.createAgentActions(withContent((c) => {
    c.decks[0].frontLayout.elements = [{ id: 't1', kind: 'text', name: '标题', x: 0, y: 0, width: 100, height: 40, rotation: 0, fill: 'transparent', color: '#000' }];
  }));
  const out = await acts['asset.use']({ asset: 'a7', deck: '主牌组', element: '标题' });
  ok(out.startsWith('❌') && out.includes('不是图片元素'), '往文字元素塞图会被拒绝', out);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exitCode = 1;
