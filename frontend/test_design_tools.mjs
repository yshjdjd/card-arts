import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const stub = { name: 'design-test-storage', setup(build) {
  build.onResolve({ filter: /db\/schema$/ }, () => ({ path: 'db', namespace: 'stub' }));
  build.onResolve({ filter: /api\/client$/ }, () => ({ path: 'api', namespace: 'stub' }));
  build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'db'
    ? `export const db = { projects: { get: async () => globalThis.designProject }, assets: { where: () => ({ equals: () => ({ toArray: async () => globalThis.designAssets || [] }) }) } }; export const uid = () => 'id'; export const emptyLayout = () => ({elements:[]}); export const defaultFields = () => [];`
    : `export const api = {listAssets: async () => ({items:globalThis.designAssets || []})}; export const assetUrl = (url) => url; export const API_BASE = '/api/v1';` }));
} };
async function load(path, plugins = []) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': '{}' }, plugins });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const G = await load('./src/lib/editorGeometry.ts');
const T = await load('./src/lib/textLayout.ts');
const F = await load('./src/lib/fontIdentity.ts');
const Fonts = await load('./src/lib/fontRuntime.ts');
const R = await load('./src/lib/render.ts');
const A = await load('./src/lib/agentTools.ts', [stub]);
const Refs = await load('./src/lib/useImages.ts', [stub]);
const el = (id, x = 0, y = 0, width = 50, height = 40) => ({ id, name: id, kind: 'text', x, y, width, height, rotation: 0, fill: 'transparent', color: '#000', fontSize: 20, text: 'Hello', wrapMode: 'word' });
const measure = { font: '20px sans-serif', measureText(text) { return { width: [...text].length * Number(this.font.match(/([\d.]+)px/)?.[1] || 20) * .5 }; } };
const ctx = () => new Proxy({ ...measure, calls: [], drawImage(...args) { this.calls.push(args); }, fillText(...args) { this.calls.push(['text', this.font, ...args]); } }, { get(target, key) { return key in target ? target[key] : () => {}; } });

test('selection expands groups but never moves locked or hidden elements', () => {
  const elements = [{ ...el('a'), groupId: 'g' }, { ...el('b'), groupId: 'g' }, { ...el('c'), groupId: 'g', locked: true }, { ...el('d'), hidden: true }];
  assert.deepEqual(G.selectionIds(elements, ['a', 'd']), ['a', 'b']);
});
test('alignment, equal gaps and group transforms preserve stable IDs', () => {
  const items = [el('a', 10), el('b', 100, 20, 70), el('c', 250, 50, 40)];
  assert.ok(G.aligned(items, 'left').every((e) => e.x === 10));
  const spaced = G.distributed(items, 'x');
  assert.equal(spaced[1].x - (spaced[0].x + spaced[0].width), spaced[2].x - (spaced[1].x + spaced[1].width));
  assert.equal(spaced[2].x, 250);
  const box = G.bounds(items), transformed = G.transformElements(items, box, { ...box, x: box.x + 30, width: box.width * 2 });
  assert.equal(transformed[0].x, 40); assert.equal(transformed[1].width, 140); assert.equal(transformed[2].id, 'c');
  assert.equal(items[0].x, 10);
});
test('snapping uses edges and centers only inside the configured threshold', () => {
  const near = G.snapped({ x: 47, y: 13, width: 10, height: 10 }, [{ x: 0, y: 0, width: 100, height: 100 }], 4);
  assert.equal(near.box.x, 45); assert.equal(near.guides[0].value, 50);
  const far = G.snapped({ x: 30, y: 30, width: 10, height: 10 }, [{ x: 0, y: 0, width: 100, height: 100 }], 2);
  assert.equal(far.guides.length, 0);
});
test('alignment treats a group as a unit rather than collapsing its internal spacing', () => {
  const elements = [{ ...el('icon', 10, 30), groupId: 'badge' }, { ...el('number', 75, 30), groupId: 'badge' }, el('label', 200, 0)];
  const aligned = G.aligned(elements, 'left');
  assert.equal(aligned[1].x - aligned[0].x, 65);
  assert.equal(aligned[2].x, 10); assert.equal(G.selectionUnitCount(elements), 2);
  const singleGroup = G.aligned(elements.slice(0, 2), 'right', { x: 0, y: 0, width: 400, height: 600 });
  assert.equal(singleGroup[1].x + singleGroup[1].width, 400);
});
test('rotated hit tests and corner resizing retain the opposite world-space corner', () => {
  const original = { ...el('a', 0, 0, 100, 20), rotation: 90 };
  assert.equal(G.hitElement(original, 50, 50), true); assert.equal(G.hitElement(original, 0, 0), false);
  const next = G.resizedRotated(original, -20, 30, 'br');
  const corner = (e) => { const a = e.rotation * Math.PI / 180; return [e.x + e.width / 2 - e.width / 2 * Math.cos(a) + e.height / 2 * Math.sin(a), e.y + e.height / 2 - e.width / 2 * Math.sin(a) - e.height / 2 * Math.cos(a)]; };
  assert.ok(corner(original).every((v, i) => Math.abs(v - corner(next)[i]) < .0001));
});
test('crop focus changes the visible portion without exposing empty space in cover mode', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(G.cropRect(200, 100, box, 'cover', 1, 0, .5), { x: 0, y: 0, width: 200, height: 100 });
  assert.equal(G.cropRect(200, 100, box, 'cover', 1, 1, .5).x, -100);
  const crop = G.cropRect(200, 100, box, 'cover', 2, .5, .5);
  assert.ok(crop.x <= 0 && crop.x + crop.width >= 100 && crop.y <= 0 && crop.y + crop.height >= 100);
});
test('fit zoom respects the actual container rather than returning a fixed scale', () => {
  assert.ok(G.fitZoom(750, 1050, 400, 500) < .5); assert.ok(G.fitZoom(750, 1050, 1500, 1600) > 1);
});
test('rich text parses styling, project images and icons; plain mode preserves syntax literally', () => {
  const text = '消耗[icon:lorc/fire]：**3伤害** [color=#ff0000]灼烧[/color] [size=40]大字[/size] [image:asset-1]';
  const runs = T.parseTextRuns(text, true, 20);
  assert.equal(runs.find((r) => r.kind === 'icon').key, 'lorc/fire');
  assert.equal(runs.find((r) => r.text === '3伤害').bold, true);
  assert.equal(runs.find((r) => r.text === '灼烧').color, '#ff0000');
  assert.equal(runs.find((r) => r.text === '大字').factor, 2);
  assert.equal(runs.find((r) => r.kind === 'image').key, 'asset-1');
  assert.equal(T.parseTextRuns(text, false)[0].text, text);
});
test('shared text measurement flags long and rich overflow and auto-fit respects exact minimum size', () => {
  const box = { ...el('text', 0, 0, 80, 30), richText: true };
  assert.equal(T.layoutText(measure, 'Long long text here', box).overflow, true);
  const fitted = T.layoutText(measure, 'some text', { ...box, autoFit: true, minFontSize: 8, maxFontSize: 24 });
  assert.equal(fitted.overflow, false); assert.ok(fitted.size >= 8 && fitted.size <= 24);
  const impossible = T.layoutText(measure, 'X'.repeat(1000), { ...box, autoFit: true, minFontSize: 8, maxFontSize: 24 });
  assert.equal(impossible.overflow, true); assert.equal(impossible.size, 8);
  const icon = T.layoutText(measure, '[icon:a/b]', { ...box, height: 100 });
  assert.equal(icon.lines[0].runs[0].width, 20);
});
test('renderer applies per-card crop overrides without mutating the shared layout', () => {
  const image = { ...el('image', 0, 0, 100, 100), kind: 'image', assetId: 'art', imageFit: 'cover' };
  const layout = { id: 'l', width: 100, height: 100, backgroundColor: '#fff', elements: [image], borderWidth: 0, borderRadius: 0 };
  const context = ctx(), art = { width: 200, height: 100 };
  R.renderLayout(context, layout, { id: 'c', values: {}, layoutOverrides: { image: { imageFocusX: 1 } } }, { values: {}, images: { art }, icons: {}, scale: 1 });
  assert.equal(context.calls[0][1], -100); assert.equal(image.imageFocusX, undefined);
});
test('renderer uses uploaded font keys and returns the same overflow diagnostics as measurement', () => {
  const text = { ...el('title', 0, 0, 30, 10), fontFamily: 'asset:custom-font' };
  const context = ctx(), diagnostics = [];
  R.renderLayout(context, { id: 'l', width: 100, height: 100, elements: [text], borderRadius: 0 }, null, { values: {}, images: {}, icons: {}, scale: 1, diagnostics });
  assert.ok(context.calls.some((c) => c[0] === 'text' && c[1].includes(F.fontFamily('custom-font'))));
  assert.ok(diagnostics.some((d) => d.elementId === 'title' && /溢出|超出/.test(d.message)));
});
test('image and inline icon reference collection includes bound card values', () => {
  const layout = { elements: [{ ...el('body'), richText: true, fieldId: 'rules' }, { ...el('art'), kind: 'image', fieldId: 'art' }] };
  const refs = Refs.collectRefs([layout], [{ id: 'c', values: { rules: '消耗[icon:lorc/fire] [image:symbol]', art: 'art-2' } }]);
  assert.ok(refs.icons.includes('lorc/fire')); assert.ok(refs.assets.includes('symbol')); assert.ok(refs.assets.includes('art-2'));
});
test('font names use collision-free deterministic CSS families and recognize all supported formats', () => {
  assert.notEqual(F.fontFamily('a-b'), F.fontFamily('a_b')); assert.equal(F.fontAssetId(F.fontKey('abc')), 'abc');
  assert.equal(F.fontMime('MYFONT.TTF'), 'font/ttf'); assert.equal(F.fontMime('font.zip'), undefined);
  assert.equal(F.validFontHeader(new Uint8Array([0, 1, 0, 0])), true);
  assert.equal(F.validFontHeader(new TextEncoder().encode('OTTO')), true);
  assert.equal(F.validFontHeader(new TextEncoder().encode('bad!')), false);
});
test('font loader awaits FontFace.load before registering and deduplicates concurrent loads', async () => {
  const original = { fetch: globalThis.fetch, FontFace: globalThis.FontFace, document: globalThis.document };
  let count = 0, added = false, release;
  const gate = new Promise((r) => release = r);
  try {
    globalThis.fetch = async () => { count++; return new Response(new Uint8Array([0, 1, 0, 0])); };
    globalThis.FontFace = class { async load() { await gate; return this; } };
    globalThis.document = { fonts: { add() { added = true; } } };
    const a = Fonts.loadFontSources([{ id: 'test-font', url: '/font' }]), b = Fonts.loadFontSources([{ id: 'test-font', url: '/font' }]);
    await Promise.resolve(); assert.equal(added, false); release(); await Promise.all([a, b]);
    assert.equal(count, 1); assert.equal(added, true);
  } finally { Object.assign(globalThis, original); }
});
test('Agent lists and assigns uploaded fonts with explicit scope and rejects invented font keys', async () => {
  globalThis.designAssets = [{ id: 'font-1', name: '标题黑体.ttf', kind: 'font' }];
  globalThis.designProject = { id: 'p', content: { settings: {}, documents: [], decks: [{ id: 'd', name: '牌组', fields: [], cards: [], frontLayout: { id: 'f', elements: [el('title'), { ...el('art'), kind: 'image' }] }, backLayout: { id: 'b', elements: [el('back-title')] } }] } };
  let writes = 0;
  const tools = A.createAgentActions({ projectId: 'p', projectName: '项目', update: async (fn) => { writes++; fn(globalThis.designProject.content); }, rename: async () => {} });
  assert.match(await tools['font.list']({}), /asset:font-1/);
  assert.match(await tools['font.set']({ font: 'invented' }), /❌/); assert.equal(writes, 0);
  const result = await tools['font.set']({ font: 'asset:font-1', deck: 'd', side: 'front', element: 'title', setDefault: true });
  assert.match(result, /✅/);
  const deck = globalThis.designProject.content.decks[0];
  assert.equal(deck.frontLayout.elements[0].fontFamily, 'asset:font-1');
  assert.equal(deck.backLayout.elements[0].fontFamily, undefined); assert.equal(deck.frontLayout.elements[1].fontFamily, undefined);
  assert.equal(globalThis.designProject.content.settings.defaultFont, 'asset:font-1');
});
