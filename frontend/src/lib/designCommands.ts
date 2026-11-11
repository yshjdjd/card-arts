import type { LayoutElement, ProjectContent } from './types';
import {MATERIALS,materialProperties} from './materials';
import { anchorElement, applyStyle, captureComponent, insertComponent, saveFlow, saveStyle, selectElements, STYLE_KEYS, syncComponent, markOverrides, designNumber, resolveDesignLayout } from './designSystem';

export function designCommand(c:ProjectContent,deckId:string,side:string,operation:string,args:Record<string,any>,id:()=>string):unknown {
  if(side!=='front'&&side!=='back')throw new Error('side 必须是 front/back');
  const deck=c.decks.find(d=>d.id===deckId);if(!deck)throw new Error('牌组不存在');
  const l=side==='front'?deck.frontLayout:deck.backLayout;if(!l)throw new Error('版式不存在');
  const ids=args.ids??[];
  const members=()=>selectElements(l,ids);
  const unlocked=()=>{const els=members();if(els.some(e=>e.locked))throw new Error('所选图层已锁定');return els;};
  switch(operation){
    case 'material.apply': {
      const els=unlocked();if(!els.length)throw new Error('请先选择形状图层');
      if(els.some(e=>!['rectangle','ellipse','path'].includes(e.kind)))throw new Error('材质预设仅支持矩形、椭圆和矢量轮廓');
      const patch=materialProperties(String(args.material??''));
      for(const e of els){markOverrides(e,patch);Object.assign(e,structuredClone(patch));}
      return {affected:els.length,material:args.material};
    }
    case 'clip.create': {
      const els=unlocked(),source=l.elements.find(e=>e.id===args.source);
      if(!source||!['rectangle','ellipse','path'].includes(source.kind)||source.clipSourceId)throw new Error('请选择未被裁切的矩形、椭圆或矢量轮廓作为裁切源');
      if(source.locked)throw new Error('裁切源已锁定');
      const targets=els.filter(e=>e.id!==source.id);
      if(!targets.length)throw new Error('至少选择一个待裁切图层');
      if(l.elements.some(e=>e.clipSourceId&&targets.some(t=>t.id===e.clipSourceId)))throw new Error('暂不支持嵌套剪切组');
      for(const e of targets){markOverrides(e,{clipSourceId:source.id});e.clipSourceId=source.id;}
      return {source:source.id,affected:targets.length};
    }
    case 'clip.release': {const els=unlocked();for(const e of els){markOverrides(e,{clipSourceId:undefined});delete e.clipSourceId;}return {affected:els.length};}
    case 'skill.create': {
      const width=Number(args.width??l.width-100),x=Number(args.x??50),y=Number(args.y??l.height*.65),fontSize=Number(args.fontSize??26);
      if(![width,x,y,fontSize].every(Number.isFinite)||width<100||fontSize<6)throw new Error('技能块尺寸或字号无效');
      for(const field of [args.titleField,args.bodyField].filter(Boolean))if(!deck.fields.some(f=>f.id===field&&f.type==='text'))throw new Error('技能绑定字段必须是本牌组真实的文本字段');
      const group=id(),titleId=id(),bodyId=id();
      const base={x:x+12,y:y+12,width:width-24,height:fontSize*1.6,rotation:0,fill:'transparent',color:'#211b13',fontSize,fontFamily:String(c.settings?.defaultFont??'sans'),groupId:group};
      const title:LayoutElement={...base,id:titleId,kind:'text',name:'技能名称',text:String(args.title??'技能名称'),fieldId:args.titleField,fontWeight:'bold',richText:true};
      const body:LayoutElement={...base,id:bodyId,kind:'text',name:'技能描述',text:String(args.body??'在此编辑技能效果。'),fieldId:args.bodyField,y:y+fontSize*2+20,height:fontSize*2,richText:true,autoFit:false,textGrowth:{maxHeight:Math.max(l.height,fontSize*3)}};
      const background:LayoutElement={id:id(),kind:'rectangle',name:'技能底板',x,y,width,height:fontSize*4+40,rotation:0,color:'#211b13',fill:'#f3e7c6',borderColor:'#aa843d',borderWidth:2,borderRadius:8,groupId:group,fitContent:{ids:[titleId,bodyId],padding:12}};
      body.stackAfter={id:titleId,gap:8};
      l.elements.push(background,title,body);
      return {group,ids:[background.id,titleId,bodyId],message:'技能块已创建，可编辑子图层、组合移动或保存为组件；长文本会撑高底板'};
    }
    case 'text.snippet.save': {
      if(!String(args.name??'').trim()||!String(args.text??'').trim())throw new Error('片段需名称和内容');
      const snippet={id:id(),name:String(args.name).slice(0,80),text:String(args.text).slice(0,10000)};
      const existing=c.settings?.textSnippets;(c.settings??={}).textSnippets=[...(Array.isArray(existing)?existing:[]),snippet];return {snippet:snippet.id};
    }
    case 'text.snippet.insert': {
      const entries=c.settings?.textSnippets;const snippet=Array.isArray(entries)?entries.find(s=>s.id===args.snippet):null;if(!snippet)throw new Error('片段不存在');
      const els=unlocked();if(els.some(e=>e.kind!=='text'||e.fieldId))throw new Error('片段插入只支持静态文本；绑定字段请编辑卡牌数据');
      for(const e of els){markOverrides(e,{text:(e.text??'')+snippet.text});e.text=(e.text??'')+snippet.text;}return {affected:els.length};
    }
    case 'element.precise': {
      const els=unlocked();const unit=args.unit??'px';if(!['px','mm'].includes(unit))throw new Error('unit 必须为 px/mm');
      const patch:Partial<LayoutElement>={};
      for(const key of ['x','y','width','height'] as const)if(args[key]!==undefined){const ratio=key==='x'||key==='width'?l.width/(l.widthMm??63.5):l.height/(l.heightMm??88.9);const n=designNumber(String(args[key]),unit,ratio);if((key==='width'||key==='height')&&n<1)throw new Error('尺寸需大于0');patch[key]=n;}
      if(!Object.keys(patch).length)throw new Error('需提供坐标或尺寸');
      for(const e of els){markOverrides(e,patch);Object.assign(e,patch);if(e.anchors)e.anchors=anchorElement(l,e,e.anchors.horizontal,e.anchors.vertical);}return {affected:els.length};
    }
    case 'style.save': {
      const selected=args.properties?null:unlocked()[0];
      const properties=args.properties??Object.fromEntries(STYLE_KEYS.filter(k=>selected?.[k]!==undefined).map(k=>[k,selected![k]]));
      return saveStyle(c,String(args.name??''),properties,id,args.style);
    }
    case 'style.apply':case 'style.reset':return {affected:applyStyle(c,l,ids,args.style,true)};
    case 'style.detach':for(const el of unlocked()){delete el.styleId;delete el.styleOverrides;}return {affected:ids.length};
    case 'component.save': {
      unlocked();const component=captureComponent(c,l,ids,String(args.name??''),id,args.component);
      return {component:component.id,revision:component.revision,affected:args.component?syncComponent(c,component.id):0};
    }
    case 'component.insert': {
      const component=c.settings?.designComponents?.find(s=>s.id===args.component);if(!component)throw new Error('组件不存在');
      const needed=component.elements.flatMap(e=>[e.fieldId,e.countFieldId,e.countSlotsFieldId]).filter(Boolean);
      if(needed.some(field=>!deck.fields.some(f=>f.id===field)))throw new Error('目标牌组缺少组件绑定字段，请先添加相同 ID 的字段');
      return insertComponent(c,l,args.component,Number(args.x??40),Number(args.y??40),id);
    }
    case 'component.sync':return {affected:syncComponent(c,args.component,false)};
    case 'component.reset':return {affected:syncComponent(c,args.component,true)};
    case 'component.detach': {
      const instances=new Set(unlocked().map(e=>e.instanceId).filter(Boolean));const targets=l.elements.filter(e=>e.instanceId&&instances.has(e.instanceId));
      if(targets.some(e=>e.locked))throw new Error('实例含锁定图层，请先解锁');
      for(const e of targets){delete e.componentId;delete e.instanceId;delete e.componentElementId;delete e.componentOverrides;}return {affected:targets.length};
    }
    case 'layout.anchor': {
      if(!['left','right','center','stretch'].includes(args.horizontal)||!['top','bottom','center','stretch'].includes(args.vertical))throw new Error('锚点参数无效');
      for(const e of unlocked())e.anchors=anchorElement(l,e,args.horizontal,args.vertical);return {affected:ids.length};
    }
    case 'layout.flow': {
      const els=unlocked();const x=Math.min(...els.map(e=>e.x)),y=Math.min(...els.map(e=>e.y));
      const flow={id:args.flow??id(),ids,direction:args.direction??'vertical',x:Number(args.x??x),y:Number(args.y??y),width:Number(args.width??Math.max(...els.map(e=>e.x+e.width-x))),gap:Number(args.gap??12),padding:Number(args.padding??0),align:args.align??'start'};
      saveFlow(l,flow);return {flow:flow.id};
    }
    case 'layout.grow': {
      const els=unlocked();if(els.some(e=>e.kind!=='text'))throw new Error('文字扩展仅支持文本层');
      if(args.image&&!l.elements.some(e=>e.id===args.image&&e.kind==='image'&&!e.locked))throw new Error('需提供未锁定的图片层 ID');
      for(const e of els){const maxHeight=Number(args.maxHeight??e.height+100),minImageHeight=Number(args.minImageHeight??100);if(!Number.isFinite(maxHeight)||maxHeight<e.height||!Number.isFinite(minImageHeight)||minImageHeight<1)throw new Error('扩展高度参数无效');e.textGrowth={maxHeight,shrinkImageId:args.image||undefined,minImageHeight};}
      return {affected:ids.length};
    }
    case 'layout.guide': {
      if(args.clear){l.guides=[];return {guides:0};}
      if(!['x','y'].includes(args.axis)||!Number.isFinite(Number(args.value)))throw new Error('参考线参数无效');
      (l.guides??=[]).push({axis:args.axis,value:Number(args.value)});return {guides:l.guides.length};
    }
    case 'layout.clear': {
      const resolved=resolveDesignLayout(l);const affected=new Set([...ids,...(l.flows??[]).filter(f=>f.ids.some(i=>ids.includes(i))).flatMap(f=>f.ids)]);
      for(const e of l.elements)if(affected.has(e.id)){const box=resolved.elements.find(r=>r.id===e.id)!;Object.assign(e,{x:box.x,y:box.y,width:box.width,height:box.height});}
      for(const e of unlocked()){delete e.anchors;delete e.textGrowth;}
      l.flows=(l.flows??[]).filter(f=>!f.ids.some((i:string)=>ids.includes(i)));return {affected:ids.length};
    }
    default:throw new Error('未知设计操作');
  }
}

export function designCatalog(c:ProjectContent){
  const items=c.decks.flatMap(d=>[d.frontLayout,d.backLayout].flatMap(l=>l?.elements.map(e=>({deck:d.id,element:e}))??[]));
  const usage=(key:'styleId'|'componentId',id:string)=>{const used=items.filter(x=>x.element[key]===id);return {layers:used.length,decks:[...new Set(used.map(x=>x.deck))],locked:used.filter(x=>x.element.locked).length,localOverrides:used.filter(x=>(key==='styleId'?x.element.styleOverrides:x.element.componentOverrides)?.length).length};};
  return {materials:MATERIALS,snippets:c.settings?.textSnippets??[],styles:(c.settings?.designStyles??[]).map(s=>({...s,usage:usage('styleId',s.id)})),components:(c.settings?.designComponents??[]).map(x=>({id:x.id,name:x.name,width:x.width,height:x.height,revision:x.revision,usage:usage('componentId',x.id),elements:x.elements.map(e=>({id:e.id,name:e.name,kind:e.kind,fieldId:e.fieldId}))})),layouts:c.decks.map(d=>({id:d.id,name:d.name,frontFlows:d.frontLayout?.flows??[],backFlows:d.backLayout?.flows??[]}))};
}
