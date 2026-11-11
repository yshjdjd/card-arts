import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/lib/cardDrafts.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {CardDrafts,cardDraftKey,applyCardValues,boundFieldIds}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tick=()=>new Promise(r=>setTimeout(r,0));
const deck=()=>({id:'d',fields:[{id:'name',name:'名称',type:'text'},{id:'cost',name:'费用',type:'number'},{id:'type',name:'类型',type:'select',options:['法术','角色']},{id:'on',name:'开关',type:'boolean'},{id:'color',name:'颜色',type:'color'}],cards:[{id:'a',values:{name:'原名称',cost:2,type:'法术',on:false}},{id:'b',values:{name:'另一张',cost:9}}]});
test('canvas drafts render immediately and coalesce changed fields without overwriting other values',async()=>{
 const d=deck(),writes=[],key=cardDraftKey('d','a');const drafts=new CardDrafts(async(k,patch)=>{writes.push(patch);applyCardValues(d,JSON.parse(k)[1],patch);},10000);
 drafts.edit(key,'name','新名称');drafts.edit(key,'name','最终名称');drafts.edit(key,'cost',4);
 assert.equal(drafts.view('d',d.cards[0]).values.name,'最终名称');assert.equal(writes.length,0);
 d.cards[0].values.on=true;await drafts.flush(key);assert.equal(writes.length,1);assert.equal(d.cards[0].values.on,true);assert.equal(d.cards[1].values.name,'另一张');
});
test('slow older saves cannot erase newer typing and writes remain serialized',async()=>{
 const d=deck(),key=cardDraftKey('d','a'),releases=[],writes=[];
 const drafts=new CardDrafts(async(k,patch)=>{writes.push(patch);await new Promise(r=>releases.push(r));applyCardValues(d,'a',patch);},10000);
 drafts.edit(key,'name','第一段');const saving=drafts.flush(key);await tick();drafts.edit(key,'name','第二段');assert.equal(drafts.view('d',d.cards[0]).values.name,'第二段');
 releases.shift()();await tick();assert.equal(writes.length,2);assert.equal(drafts.view('d',d.cards[0]).values.name,'第二段');releases.shift()();await saving;assert.equal(d.cards[0].values.name,'第二段');
});
test('Chinese composition blocks autosave and switching until the final value is available',async()=>{
 let count=0;const key=cardDraftKey('d','a');const drafts=new CardDrafts(async()=>{count++;},5);
 drafts.pause(key,'name',true);drafts.edit(key,'name','中文输');await new Promise(r=>setTimeout(r,12));assert.equal(count,0);assert.equal(await drafts.flushAll(),false);
 drafts.edit(key,'name','中文输入完成');drafts.pause(key,'name',false);await drafts.flush(key);assert.equal(count,1);
});
test('failed saves retain drafts and retry only their own card target',async()=>{
 const d=deck(),a=cardDraftKey('d','a'),b=cardDraftKey('d','b');let fail=true;
 const drafts=new CardDrafts(async(k,patch)=>{if(fail)throw new Error('storage failed');applyCardValues(d,JSON.parse(k)[1],patch);},10000);
 drafts.edit(a,'name','A草稿');drafts.edit(b,'name','B草稿');assert.equal(await drafts.flush(a),false);assert.equal(drafts.status(a),'error');assert.equal(drafts.view('d',d.cards[0]).values.name,'A草稿');
 fail=false;await drafts.flushAll();assert.equal(d.cards[0].values.name,'A草稿');assert.equal(d.cards[1].values.name,'B草稿');assert.equal(drafts.hasUnsaved(),false);
});
test('acknowledged drafts release overlays so project undo and external edits remain visible',async()=>{
 const d=deck(),key=cardDraftKey('d','a');const drafts=new CardDrafts(async(k,p)=>applyCardValues(d,'a',p),10000);
 drafts.edit(key,'name','已保存');await drafts.flush(key);d.cards[0].values.name='撤销后的值';drafts.reconcile([d]);assert.equal(drafts.view('d',d.cards[0]).values.name,'撤销后的值');
});
test('field and target validation is atomic and never recreates deleted cards',()=>{
 const d=deck();assert.throws(()=>applyCardValues(d,'a',{name:'不能部分写入',cost:Infinity}));assert.equal(d.cards[0].values.name,'原名称');
 assert.throws(()=>applyCardValues(d,'missing',{name:'x'}));assert.throws(()=>applyCardValues(d,'a',{type:'不存在'}));assert.throws(()=>applyCardValues(d,'a',{on:'true'}));assert.throws(()=>applyCardValues(d,'a',{missing:'x'}));
 applyCardValues(d,'a',{cost:'',on:true,color:'#ff0000'});assert.equal(d.cards[0].values.cost,'');assert.equal(d.cards[0].values.on,true);
});
test('double-click binding discovery includes interpolated color and text references without duplicate IDs',()=>{
 assert.deepEqual(boundFieldIds({fieldId:'name',text:'{name} {cost}',fill:'{color}',color:'{missing}'},deck()),['name','cost','color']);
});
test('discarding failed input clears local overlays without altering saved data',async()=>{
 const d=deck(),key=cardDraftKey('d','a');const drafts=new CardDrafts(async()=>{throw new Error('deleted field');},10000);
 drafts.edit(key,'name','草稿');await drafts.flush(key);await drafts.discard(key);assert.equal(drafts.view('d',d.cards[0]).values.name,'原名称');assert.equal(drafts.hasUnsaved(),false);
});

test('same card IDs in different decks remain separate targets',async()=>{
 const first=deck(),second={...deck(),id:'other'};const all=[first,second];
 const drafts=new CardDrafts(async(key,patch)=>{const [deckId,cardId]=JSON.parse(key);applyCardValues(all.find(d=>d.id===deckId),cardId,patch);},10000);
 drafts.edit(cardDraftKey('d','a'),'name','第一个牌组');drafts.edit(cardDraftKey('other','a'),'name','第二个牌组');await drafts.flushAll();assert.equal(first.cards[0].values.name,'第一个牌组');assert.equal(second.cards[0].values.name,'第二个牌组');
});
