import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const stub = { name: 'design-test-storage', setup(build) {
  build.onResolve({ filter: /db\/schema$/ }, () => ({ path: 'db', namespace: 'stub' }));
  build.onResolve({ filter: /api\/client$/ }, () => ({ path: 'api', namespace: 'stub' }));
  build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'db'
    ? `export const db = { projects: { get: async () => globalThis.designProject }, assets: { where: () => ({ equals: () => ({ toArray: async () => globalThis.designAssets || [] }) }) } }; export const uid = () => globalThis.designUid ? globalThis.designUid() : 'id'; export const emptyLayout = () => ({elements:[]}); export const defaultFields = () => [];`
    : `export const req=async()=>{throw new Error('desktop service unavailable in test')}; export const api = {listAssets: async () => ({items:globalThis.designAssets || []})}; export const assetUrl = (url) => url; export const API_BASE = '/api/v1';` }));
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

const Layers=await load('./src/lib/layers.ts');
const layerFixture=()=>[{id:'bg',name:'背景',kind:'rectangle'},{id:'a',name:'标题',kind:'text',groupId:'g'},{id:'b',name:'费用',kind:'text',groupId:'g'},{id:'art',name:'图片',kind:'image'}];
test('layer ordering preserves IDs, relative order and expands groups',()=>{
 const original=layerFixture(), names=x=>x.map(e=>e.id);
 assert.deepEqual(names(Layers.applyLayers(original,{operation:'front',ids:['a']})),['bg','art','a','b']);
 assert.deepEqual(names(Layers.applyLayers(original,{operation:'down',ids:['a']})),['a','b','bg','art']);
 assert.deepEqual(names(Layers.applyLayers(original,{operation:'above',ids:['bg'],target:'art'})),['a','b','art','bg']);
 assert.deepEqual(names(original),['bg','a','b','art']);
 assert.equal(Layers.listLayers(original)[0].id,'art');
});
test('layer locking, exact target validation and full ordering reject invalid changes',()=>{
 const original=layerFixture();original[1].locked=true;
 assert.throws(()=>Layers.applyLayers(original,{operation:'front',ids:['a']}),/锁定/);
 assert.throws(()=>Layers.applyLayers(original,{operation:'hide',ids:['missing']}),/真实/);
 assert.throws(()=>Layers.applyLayers(original,{operation:'order',ids:[],order:['bg','bg']}));
 assert.throws(()=>Layers.applyLayers(original,{operation:'below',ids:['bg'],target:'missing'}));
 const unlocked=Layers.applyLayers(original,{operation:'unlock',ids:['a']});
 assert.equal(unlocked[1].locked,false);
 const hidden=Layers.applyLayers(unlocked,{operation:'hide',ids:['a']});assert.equal(hidden[2].hidden,true);
 const one=Layers.applyLayers(hidden,{operation:'show',ids:['a'],expandGroups:false});assert.equal(one[1].hidden,false);assert.equal(one[2].hidden,true);
});
test('layer rename and grouping do not change geometry or field binding',()=>{
 const original=layerFixture();original[1].fieldId='name';
 const renamed=Layers.applyLayers(original,{operation:'rename',ids:['a'],name:'新标题'});assert.equal(renamed[1].fieldId,'name');
 const grouped=Layers.applyLayers(renamed,{operation:'group',ids:['a','bg'],groupId:'new'});assert.equal(grouped[2].groupId,'new');
 const ungrouped=Layers.applyLayers(grouped,{operation:'ungroup',ids:['a']});assert.equal(ungrouped[0].groupId,undefined);
});

const Templates=await load('./src/lib/cardTemplates.ts');
const emptyDeck=()=>({id:'deck',name:'existing',fields:[{id:'name',name:'名称',type:'text'},{id:'count',name:'数量',type:'number'}],cards:[{id:'card',values:{name:'原卡牌',count:2}}],frontLayout:null,backLayout:null});
test('all built-in templates compile to editable in-bounds layouts for every size and theme',()=>{
 for(const template of Templates.CARD_TEMPLATES)for(const theme of Object.keys(Templates.TEMPLATE_THEMES))for(const preset of ['poker','square','tarot','mini']){
  let n=0;const result=Templates.instantiateTemplate(template,emptyDeck(),{theme,preset},()=>`t${++n}`);
  const ids=result.deck.frontLayout.elements.map(e=>e.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const layout of [result.deck.frontLayout,result.deck.backLayout])for(const el of layout.elements){
   assert.ok(el.x>=0&&el.y>=0&&el.x+el.width<=layout.width+0.01&&el.y+el.height<=layout.height+0.01,template.id+' '+el.name);
   if(el.fieldId)assert.ok(result.deck.fields.some(f=>f.id===el.fieldId));
  }
  assert.equal(result.deck.cards[0].values.name,'原卡牌');assert.equal(result.deck.cards[0].values.count,2);
 }
});
test('template mapping preserves card data and only replaces requested side',()=>{
 const deck=emptyDeck();deck.backLayout={id:'back',elements:[]};deck.fields.push({id:'rules',name:'效果',type:'text'});deck.cards[0].values.rules='原规则';
 let n=0;const result=Templates.instantiateTemplate(Templates.CARD_TEMPLATES[0],deck,{side:'front',mapping:{description:'rules'}},()=>`t${++n}`);
 assert.equal(result.bindings.description,'rules');assert.equal(result.deck.cards[0].values.rules,'原规则');assert.equal(result.deck.backLayout.id,'back');
 assert.equal(deck.frontLayout,null);
 assert.throws(()=>Templates.instantiateTemplate(Templates.CARD_TEMPLATES[0],deck,{mapping:{art:'rules'}},()=>`t${++n}`),/映射/);
 assert.throws(()=>Templates.instantiateTemplate(Templates.CARD_TEMPLATES[0],deck,{preset:'missing'},()=>`t${++n}`),/尺寸/);
});
test('project templates remap IDs, groups, fields and conditions without modifying source',()=>{
 let n=0;const built=Templates.instantiateTemplate(Templates.CARD_TEMPLATES[0],emptyDeck(),{},()=>`t${++n}`).deck;
 built.frontLayout.elements[0].displayCondition={type:'comparison',fieldId:'cost',operator:'gt',value:0};
 const content={decks:[built],documents:[],settings:{}};const custom=Templates.captureTemplate(content,built,'项目模板',()=>`t${++n}`);
 const original=JSON.stringify(custom);const target=emptyDeck();target.fields.push({id:'price',name:'消耗',type:'number'});
 const result=Templates.instantiateTemplate(custom,target,{mapping:{cost:'price'}},()=>`t${++n}`);
 assert.equal(result.deck.frontLayout.elements[0].displayCondition.fieldId,'price');assert.equal(JSON.stringify(custom),original);
 assert.ok(!result.deck.frontLayout.elements.some(e=>built.frontLayout.elements.some(old=>old.id===e.id)));
});

test('Agent can discover, inspect, create and capture templates without changing old card data',async()=>{
 let id=0;globalThis.designUid=()=>`agent-template-${++id}`;
 const existing=emptyDeck();globalThis.designProject={id:'p',content:{decks:[existing],documents:[],settings:{}}};
 const actions=await load('./src/lib/agentTools.ts',[stub]);
 const tools=actions.createAgentActions({projectId:'p',projectName:'qa',update:async fn=>fn(globalThis.designProject.content),rename:async()=>{}});
 assert.ok(JSON.parse(await tools['template.list']({})).length>=10);
 const before=JSON.stringify(existing.cards);
 const preview=JSON.parse(await tools['template.inspect']({template:'unit',deck:'deck',side:'front'}));assert.equal(preview.template,'unit');assert.equal(existing.frontLayout,null);
 await tools['template.create']({template:'spell',name:'法术模板牌组'});assert.equal(globalThis.designProject.content.decks.length,2);
 const elements=globalThis.designProject.content.decks[1].frontLayout.elements;assert.equal(new Set(elements.map(e=>e.id)).size,elements.length);
 await tools['template.apply']({template:'unit',deck:'deck',side:'front'});assert.equal(JSON.stringify(existing.cards.map(c=>({id:c.id,values:{name:c.values.name,count:c.values.count}}))),before);
 await tools['template.save']({deck:'deck',name:'我的模板'});assert.ok(JSON.parse(await tools['template.list']({})).some(t=>t.custom));
 delete globalThis.designUid;
});

test('captured project template retains recommended physical dimensions when creating a new deck',()=>{
 let n=0;const built=Templates.instantiateTemplate(Templates.CARD_TEMPLATES.find(t=>t.id==='tarot'),emptyDeck(),{},()=>`s${++n}`).deck;
 const custom=Templates.captureTemplate({decks:[built],documents:[]},built,'塔罗项目模板',()=>`s${++n}`);
 const applied=Templates.instantiateTemplate(custom,emptyDeck(),{},()=>`s${++n}`).deck;
 assert.equal(applied.frontLayout.height,1425);assert.equal(applied.frontLayout.heightMm,120.7);
});

const DS=await load('./src/lib/designSystem.ts');
const DC=await load('./src/lib/designCommands.ts');
function designFixture(){return {decks:[{id:'d',fields:[{id:'name',name:'名称',type:'text'}],cards:[],frontLayout:{id:'l',width:750,height:1050,widthMm:63.5,heightMm:88.9,elements:[{id:'a',name:'标题',kind:'text',x:30,y:30,width:200,height:60,fieldId:'name',fontSize:32,color:'#111111',fill:'#ffffff'},{id:'b',name:'徽章',kind:'ellipse',x:250,y:30,width:80,height:80,fill:'#ff0000'}]},backLayout:null}],documents:[],settings:{}};}
test('shared styles propagate while preserving local overrides, field binding and content',()=>{
 const c=designFixture(),l=c.decks[0].frontLayout;let n=0;
 const saved=DS.saveStyle(c,'标题',{fontSize:40,color:'#223344'},()=>`style${++n}`);
 DS.applyStyle(c,l,['a'],saved.style.id);DS.markOverrides(l.elements[0],{color:'#abcdef'});l.elements[0].color='#abcdef';
 DS.saveStyle(c,'标题更新',{fontSize:48,color:'#000000'},()=>'',saved.style.id);
 assert.equal(l.elements[0].fontSize,48);assert.equal(l.elements[0].color,'#abcdef');assert.equal(l.elements[0].fieldId,'name');
 DS.applyStyle(c,l,['a'],saved.style.id);assert.equal(l.elements[0].color,'#000000');assert.deepEqual(l.elements[0].styleOverrides,[]);
});
test('components preserve live IDs, instance offsets and explicit local overrides on master sync',()=>{
 const c=designFixture(),l=c.decks[0].frontLayout;let n=0;const id=()=>`comp${++n}`;
 const master=DS.captureComponent(c,l,['a','b'],'费用',id);const instance=DS.insertComponent(c,l,master.id,300,400,id);
 const original=l.elements.find(e=>e.id===instance.ids[0]);const before=original.id;
 DS.markOverrides(original,{color:'#123456'});original.color='#123456';master.elements[0].fontSize=55;
 assert.equal(DS.syncComponent(c,master.id),1);const changed=l.elements.find(e=>e.id===before);
 assert.equal(changed.fontSize,55);assert.equal(changed.color,'#123456');assert.equal(changed.x,300);assert.equal(changed.fieldId,'name');
 DS.syncComponent(c,master.id,true);assert.equal(l.elements.find(e=>e.id===before).color,master.elements[0].color);
});
test('anchors, auto flow and text growth resolve per card without mutating source geometry',()=>{
 const c=designFixture(),l=c.decks[0].frontLayout;l.elements[0].anchors=DS.anchorElement(l,l.elements[0],'right','bottom');
 const resized={...l,width:1000,height:1400};const anchored=DS.resolveDesignLayout(resized);assert.equal(anchored.elements[0].x,280);assert.equal(anchored.elements[0].y,380);
 const image={id:'img',kind:'image',x:30,y:100,width:500,height:300};l.elements.push(image);l.elements[0].anchors=undefined;l.elements[0].y=420;l.elements[0].height=100;l.elements[0].textGrowth={maxHeight:250,shrinkImageId:'img',minImageHeight:180};
 const grown=DS.resolveDesignLayout(l,()=>230);assert.equal(grown.elements[0].height,220);assert.equal(grown.elements[0].y,300);assert.equal(grown.elements[2].height,180);assert.equal(l.elements[2].height,300);
 DS.saveFlow(l,{id:'f',ids:['a','b'],direction:'vertical',x:10,y:20,width:300,gap:15,padding:5,align:'start'});
 const flow=DS.resolveDesignLayout(l);assert.equal(flow.elements[0].y,25);assert.equal(flow.elements[1].y,140);
 assert.throws(()=>DS.saveFlow(l,{id:'other',ids:['a'],direction:'vertical',x:0,y:0,width:100,gap:0,padding:0,align:'start'}),/只能/);
});
test('precise unit expressions are safe and reject code, non-finite values and invalid effects',()=>{
 assert.equal(DS.designNumber('(20-4)/2'),8);assert.equal(DS.designNumber('10+2','mm',10),120);
 assert.throws(()=>DS.designNumber('window.alert(1)'));assert.throws(()=>DS.designNumber('1/0'));
 assert.throws(()=>DS.validateDesignPatch({padding:-1}));assert.throws(()=>DS.validateDesignPatch({gradient:{from:'#fff',to:'#000',angle:NaN}}));
});
test('shared design commands require exact scopes and preserve fields when inserting components',()=>{
 const c=designFixture();let n=0;const id=()=>`cmd${++n}`;
 const master=DC.designCommand(c,'d','front','component.save',{ids:['a','b'],name:'费用'},id);
 const placed=DC.designCommand(c,'d','front','component.insert',{component:master.component,x:400,y:500},id);
 assert.equal(placed.ids.length,2);assert.throws(()=>DC.designCommand(c,'d','both','layout.anchor',{},id));
 DC.designCommand(c,'d','front','text.snippet.save',{name:'规则',text:'造成伤害'},id);assert.equal(c.settings.textSnippets.length,1);
});

test('paragraph spacing and inline image sizing participate in measured text height',()=>{
 const basic={...el('p',0,0,200,200),fontSize:20,wrapMode:'anywhere',padding:10,firstLineIndent:12,paragraphSpacing:8};
 const result=T.layoutText(measure,'第一段\n第二段',basic,1);
 assert.equal(result.lines[0].runs[0].x,12);assert.equal(result.lines[0].gapAfter,8);assert.equal(result.height,58);
 const inline=T.layoutText(measure,'[image:asset]',{...basic,richText:true,inlineIconScale:2,inlineIconOffset:3},1);
 assert.equal(inline.lines[0].runs[0].size,40);assert.ok(inline.height>=56);
});
test('project templates remap automatic flow member IDs when cloned',()=>{
 let n=0;const c=designFixture(),l=c.decks[0].frontLayout;
 DS.saveFlow(l,{id:'f',ids:['a','b'],direction:'vertical',x:10,y:20,width:300,gap:15,padding:5,align:'start'});
 const custom=Templates.captureTemplate(c,c.decks[0],'流式组件模板',()=>`t${++n}`);
 const created=Templates.instantiateTemplate(custom,emptyDeck(),{},()=>`t${++n}`).deck.frontLayout;
 assert.ok(created.flows[0].ids.every(id=>created.elements.some(e=>e.id===id)));
 assert.ok(created.flows[0].ids.every(id=>!['a','b'].includes(id)));
});

test('precision commands use physical dimensions and detaching flow retains visible positions',()=>{
 const c=designFixture(),l=c.decks[0].frontLayout;
 DC.designCommand(c,'d','front','element.precise',{ids:['a'],x:'10+2',unit:'mm'},()=> 'new');assert.ok(Math.abs(l.elements[0].x-12*750/63.5)<.001);
 DC.designCommand(c,'d','front','layout.flow',{ids:['a','b'],direction:'vertical',gap:20,x:50,y:60,padding:5},()=> 'flow');
 const before=DS.resolveDesignLayout(l);DC.designCommand(c,'d','front','layout.clear',{ids:['a','b']},()=> 'x');
 assert.equal(l.elements[0].x,before.elements[0].x);assert.equal(l.elements[1].y,before.elements[1].y);assert.equal(l.flows.length,0);
});
test('capturing a new component from multiple instances never duplicates slot IDs',()=>{
 const c=designFixture(),l=c.decks[0].frontLayout;let n=0;const id=()=>`multi${++n}`;
 const master=DS.captureComponent(c,l,['a'],'master',id);const first=DS.insertComponent(c,l,master.id,10,10,id);const second=DS.insertComponent(c,l,master.id,200,10,id);
 const combined=DS.captureComponent(c,l,[...first.ids,...second.ids],'combined',id);
 assert.equal(new Set(combined.elements.map(e=>e.id)).size,2);
});


test('skill blocks grow and component instances keep independent container references',()=>{
 let seq=0;const id=()=>`skill-${++seq}`;
 const layout={id:'l',width:750,height:1050,elements:[]};
 const c={decks:[{id:'d',fields:[],frontLayout:layout}],settings:{}};
 const created=DC.designCommand(c,'d','front','skill.create',{title:'仁德',body:'描述',x:20,y:30,width:400},id);
 const resolved=DS.resolveDesignLayout(layout,()=>160);
 const body=resolved.elements.find(e=>e.name==='技能描述'),title=resolved.elements.find(e=>e.name==='技能名称'),bg=resolved.elements.find(e=>e.fitContent);
 assert.equal(body.y,title.y+title.height+8);assert.ok(bg.y+bg.height>=body.y+body.height+12);
 const saved=DC.designCommand(c,'d','front','component.save',{ids:created.ids,name:'技能'},id);
 const inserted=DC.designCommand(c,'d','front','component.insert',{component:saved.component,x:450,y:100},id);
 const instance=layout.elements.filter(e=>inserted.ids.includes(e.id));
 assert.ok(instance.find(e=>e.fitContent).fitContent.ids.every(x=>inserted.ids.includes(x)));
 assert.ok(inserted.ids.includes(instance.find(e=>e.stackAfter).stackAfter.id));
 instance.forEach(e=>{e.x+=50;e.y+=70;});
 const moved=DS.resolveDesignLayout(layout,()=>160),newTitle=moved.elements.find(e=>e.id===instance.find(e=>e.name==='技能名称').id);
 assert.equal(newTitle.x,512);
 assert.equal(layout.elements.find(e=>e.id===created.ids[1]).x,32);
});

const V=await load('./src/lib/verticalText.ts');
test('vertical text wraps into ordered columns, retains rich styles and reports overflow',()=>{
 const e={...el('v'),width:100,height:45,fontSize:20,lineHeight:1,writingMode:'vertical-rl',richText:true};
 const r=V.layoutVertical('**刘备**仁德',e);
 assert.equal(r.glyphs.length,4);assert.ok(r.glyphs[0].font.includes('bold'));
 assert.equal(r.glyphs[0].x,80);assert.equal(r.glyphs[2].x,60);assert.equal(r.overflow,false);
 const lr=V.layoutVertical('刘备仁德',{...e,writingMode:'vertical-lr'});assert.equal(lr.glyphs[0].x,0);
 assert.equal(V.layoutVertical('刘备仁德',{...e,width:10}).overflow,true);
 assert.equal(V.layoutVertical('刘\n备',e).glyphs[1].y,0);
});

test('clipping commands validate sources, reject nesting and preserve instance references',()=>{
 let n=0;const id=()=>`clip-${++n}`;
 const l={id:'l',width:750,height:1050,elements:[{...el('mask'),kind:'ellipse'},el('art')]};
 const c={decks:[{id:'d',fields:[],frontLayout:l}],settings:{}};
 assert.throws(()=>DC.designCommand(c,'d','front','clip.create',{ids:['art'],source:'missing'},id));
 DC.designCommand(c,'d','front','clip.create',{ids:['art'],source:'mask'},id);assert.equal(l.elements[1].clipSourceId,'mask');
 const master=DS.captureComponent(c,l,['mask','art'],'裁切组件',id);
 const placed=DS.insertComponent(c,l,master.id,200,100,id);
 const art=l.elements.find(e=>placed.ids.includes(e.id)&&e.name==='art');
 assert.ok(placed.ids.includes(art.clipSourceId));assert.notEqual(art.clipSourceId,'mask');
 DC.designCommand(c,'d','front','clip.release',{ids:['art']},id);assert.equal(l.elements[1].clipSourceId,undefined);
});

test('shape textures are collected for editor and export even when the base fill is transparent',()=>{
 const l={id:'texture',width:100,height:100,elements:[{...el('a'),kind:'path',fill:'transparent',textureAssetId:'gold',shapePath:'M0 0 L100 0 L50 100 Z'},{...el('b'),kind:'ellipse',textureAssetId:'gold'}]};
 assert.deepEqual(Refs.collectRefs([l]).assets,['gold']);
});

test('material presets replace visual effects, preserve geometry and reject mixed selections atomically',()=>{
 const shape={...el('shape'),kind:'path',shapePath:'M0 0 L100 0 L50 100 Z',textureAssetId:'old',styleId:'shared'};
 const l={id:'l',width:750,height:1050,elements:[shape,el('text')]};
 const c={decks:[{id:'d',fields:[],frontLayout:l}],settings:{}};
 assert.throws(()=>DC.designCommand(c,'d','front','material.apply',{ids:['shape','text'],material:'gold'},()=> 'id'));
 assert.equal(shape.textureAssetId,'old');
 DC.designCommand(c,'d','front','material.apply',{ids:['shape'],material:'gold'},()=> 'id');
 assert.equal(shape.textureAssetId,undefined);assert.equal(shape.gradient.from,'#fff2ad');assert.equal(shape.x,0);
 assert.equal(shape.shapePath,'M0 0 L100 0 L50 100 Z');assert.ok(shape.styleOverrides.includes('gradient'));
 assert.equal(DC.designCatalog(c).materials.length,6);
 shape.locked=true;assert.throws(()=>DC.designCommand(c,'d','front','material.apply',{ids:['shape'],material:'jade'},()=> 'id'));
});

test('fixed health slots preserve empty and half values while legacy counts stay rounded',()=>{
 const e={...el('health'),countFieldId:'hp',countSlots:4,countMax:8,countHalf:true,countSpacing:5};
 const slots=R.expandCount(e,{hp:2.5});assert.deepEqual(slots.map(s=>s.slotFraction),[1,1,.5,0]);
 assert.equal(slots[1].x,e.width+5);assert.equal(R.expandCount(e,{hp:0}).length,4);
 assert.deepEqual(R.expandCount(e,{hp:'invalid'}).map(s=>s.slotFraction),[0,0,0,0]);
 assert.equal(R.expandCount({...e,countSlots:undefined,countHalf:false},{hp:2.5}).length,3);
 assert.equal(R.expandCount({...e,countSlots:1000,countMax:5000},{hp:9999}).length,100);
 assert.deepEqual(R.expandCount({...e,countDirection:'vertical'},{hp:1}).map(s=>s.y),[0,45,90,135]);
});

test('health capacity binds per card and handles zero, missing and invalid totals',()=>{
 const e={...el('hp'),countFieldId:'hp',countSlots:8,countSlotsFieldId:'maxHp',countHalf:true};
 assert.deepEqual(R.expandCount(e,{hp:2.5,maxHp:4}).map(x=>x.slotFraction),[1,1,.5,0]);
 assert.equal(R.expandCount(e,{hp:5,maxHp:3}).length,3);
 for(const maxHp of [0,-2,'bad',undefined])assert.equal(R.expandCount(e,{hp:2,maxHp}).length,0);
 assert.equal(R.expandCount({...e,countSlotsFieldId:undefined},{hp:2}).length,8);
});

const LS=await load('./src/lib/layerSelection.ts');
test('layer panel supports toggling, visible range selection and group member selection',()=>{
 const layers=[el('a'),{...el('b'),groupId:'g'},{...el('c'),groupId:'g'},el('d')],visible=['d','c','b','a'];
 assert.deepEqual(LS.pickLayers(layers,visible,['a'],'d','a',{toggle:true}),['a','d']);
 assert.deepEqual(LS.pickLayers(layers,visible,['a','d'],'d','a',{toggle:true}),['a']);
 assert.deepEqual(LS.pickLayers(layers,visible,[],'b','d',{range:true,singleMember:true}),['d','c','b']);
 assert.deepEqual(LS.pickLayers(layers,visible,[],'b',null),['b','c']);
 assert.deepEqual(LS.pickLayers(layers,visible,[],'b',null,{singleMember:true}),['b']);
 assert.deepEqual(LS.pickLayers(layers,['d','a'],[],'a','d',{range:true}),['d','a']);
});


test('group naming is independent of members and rename reaches the entire group',()=>{
 const original=[el('a'),el('b'),el('c')];
 const grouped=Layers.applyLayers(original,{operation:'group',ids:['a','b'],groupId:'g'});
 const renamed=Layers.applyLayers(grouped,{operation:'renameGroup',ids:['a'],name:'技能区',expandGroups:false});
 assert.equal(renamed[0].groupName,'技能区');assert.equal(renamed[1].groupName,'技能区');assert.equal(renamed[0].name,'a');
 assert.equal(Layers.listLayers(renamed).find(x=>x.id==='b').groupName,'技能区');
 assert.throws(()=>Layers.applyLayers(renamed,{operation:'renameGroup',ids:['a','c'],name:'bad'}));
 const cleared=Layers.applyLayers(renamed,{operation:'ungroup',ids:['a']});assert.equal(cleared[1].groupName,undefined);
 assert.equal(original[0].groupId,undefined);
});
