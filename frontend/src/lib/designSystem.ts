import type { DesignComponent, DesignStyle, ElementAnchors, Layout, LayoutElement, LayoutFlow, ProjectContent } from './types';

export const STYLE_KEYS=['textureAssetId','textureMode','textureScale','writingMode','fontFamily','fontSize','minFontSize','maxFontSize','fontWeight','fontStyle','lineHeight','letterSpacing','color','fill','fillOpacity','textOpacity','borderColor','borderWidth','borderStyle','borderRadius','horizontalAlign','verticalAlign','padding','paragraphSpacing','firstLineIndent','inlineIconScale','inlineIconOffset','shadow','gradient'] as const;
const styleKeys=new Set<string>(STYLE_KEYS);
export function validateDesignPatch(patch:Partial<LayoutElement>){
  if(patch.writingMode!==undefined&&!['horizontal','vertical-rl','vertical-lr'].includes(patch.writingMode))throw new Error('未知文字方向');
  if(patch.textureMode!==undefined&&!['cover','repeat'].includes(patch.textureMode))throw new Error('未知纹理方式');
  if(patch.textureScale!==undefined&&(!Number.isFinite(patch.textureScale)||patch.textureScale<=0))throw new Error('纹理缩放必须为正数');
  for(const k of ['countMax','countSlots'] as const)if(patch[k]!==undefined&&(!Number.isInteger(patch[k])||patch[k]!<0||patch[k]!>100))throw new Error('格数必须是 0–100 的整数');
  if(patch.countEmptyOpacity!==undefined&&(!Number.isFinite(patch.countEmptyOpacity)||patch.countEmptyOpacity<0||patch.countEmptyOpacity>1))throw new Error('空格透明度必须为 0–1');
  if(patch.pathViewBox&&(!Array.isArray(patch.pathViewBox)||patch.pathViewBox.length!==4||!patch.pathViewBox.every(Number.isFinite)||patch.pathViewBox[2]<=0||patch.pathViewBox[3]<=0))throw new Error('路径 viewBox 无效');
  for(const key of ['padding','paragraphSpacing','firstLineIndent','fontSize','minFontSize','maxFontSize','inlineIconScale'] as const){const v=patch[key];if(v!==undefined&&(!Number.isFinite(v)||v<0||(key==='inlineIconScale'&&v===0)))throw new Error(`无效属性 ${key}`);}
  const validColor=(v:string)=>typeof CSS==='undefined'||CSS.supports('color',v);
  if(patch.gradient&&(!validColor(patch.gradient.from)||!validColor(patch.gradient.to)))throw new Error('渐变颜色无效');
  if(patch.shadow&&!validColor(patch.shadow.color))throw new Error('阴影颜色无效');
  if(patch.gradient&&(![patch.gradient.from,patch.gradient.to].every(x=>typeof x==='string'&&x.length>0)||!Number.isFinite(patch.gradient.angle)))throw new Error('渐变参数无效');
  if(patch.shadow&&(![patch.shadow.blur,patch.shadow.x,patch.shadow.y].every(Number.isFinite)||patch.shadow.blur<0||typeof patch.shadow.color!=='string'))throw new Error('阴影参数无效');
  if(patch.maskPath){if(typeof patch.maskPath!=='string'||patch.maskPath.length>4000||!/^\s*[Mm]/.test(patch.maskPath)||!/^[MmLlHhVvCcSsQqTtAaZz\d\s.,+\-eE]+$/.test(patch.maskPath))throw new Error('蒙版路径过长或无效');if(typeof Path2D!=='undefined'){try{new Path2D(patch.maskPath);}catch{throw new Error('SVG 蒙版路径无效');}}}
  if(patch.imageMask&&!['ellipse','rectangle'].includes(patch.imageMask))throw new Error('未知图片蒙版');
  if(patch.blendMode&&!['source-over','multiply','screen','overlay'].includes(patch.blendMode))throw new Error('未知混合模式');
}
export const layouts=(content:ProjectContent)=>content.decks.flatMap(d=>[d.frontLayout,d.backLayout].filter((l):l is Layout=>!!l));
export function styleProperties(properties:Partial<LayoutElement>):Partial<LayoutElement>{
  if(!properties||typeof properties!=='object'||Array.isArray(properties))throw new Error('样式 properties 必须为对象');
  validateDesignPatch(properties);
  const out:Partial<LayoutElement>={};
  for(const [key,value] of Object.entries(properties)){if(!styleKeys.has(key))throw new Error(`样式不允许属性 ${key}`);if(typeof value==='number'&&!Number.isFinite(value))throw new Error('样式数值必须有限');(out as any)[key]=structuredClone(value);}
  return out;
}
export function saveStyle(c:ProjectContent,name:string,properties:Partial<LayoutElement>,id:()=>string,existingId?:string){
  if(!name.trim())throw new Error('样式名称不能为空');const props=styleProperties(properties);
  const styles=(c.settings??={}).designStyles??=[];c.settings.designStyles=styles;
  let style=existingId?styles.find(s=>s.id===existingId):undefined;if(existingId&&!style)throw new Error('样式不存在');
  if(style){style.name=name;style.properties={...style.properties,...props};style.revision++;}else{style={id:id(),name,properties:props,revision:1};styles.push(style);}
  let affected=0;
  for(const l of [...layouts(c),...(c.settings?.designComponents??[])])for(const el of l.elements)if(el.styleId===style.id){if(el.locked)continue;for(const [key,value] of Object.entries(style.properties))if(!el.styleOverrides?.includes(key))(el as any)[key]=structuredClone(value);affected++;}
  return {style,affected};
}
export function selectElements(l:Layout,ids:string[]):LayoutElement[]{
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!l.elements.some(e=>e.id===id)))throw new Error('请提供当前版式的真实元素 ID');
  return l.elements.filter(e=>ids.includes(e.id));
}
export function applyStyle(c:ProjectContent,l:Layout,ids:string[],styleId:string,reset=true){
  const style=c.settings?.designStyles?.find(s=>s.id===styleId);if(!style)throw new Error('样式不存在');
  const elements=selectElements(l,ids);if(elements.some(e=>e.locked))throw new Error('请先解锁所选元素');
  for(const el of elements){if(el.componentId)el.componentOverrides=[...new Set([...(el.componentOverrides??[]),...Object.keys(style.properties),'styleId','styleOverrides'])];el.styleId=styleId;if(reset)el.styleOverrides=[];for(const [key,value] of Object.entries(style.properties))if(!el.styleOverrides?.includes(key))(el as any)[key]=structuredClone(value);}
  return elements.length;
}
export function markOverrides(el:LayoutElement,patch:Partial<LayoutElement>){
  if(el.styleId)el.styleOverrides=[...new Set([...(el.styleOverrides??[]),...Object.keys(patch).filter(k=>styleKeys.has(k))])];
  if(el.componentId)el.componentOverrides=[...new Set([...(el.componentOverrides??[]),...Object.keys(patch).filter(k=>!['id','componentId','instanceId','componentElementId','componentOverrides'].includes(k))])];
}
export function captureComponent(c:ProjectContent,l:Layout,ids:string[],name:string,id:()=>string,existingId?:string){
  const members=selectElements(l,ids);if(!name.trim())throw new Error('组件名称不能为空');
  const left=Math.min(...members.map(e=>e.x)),top=Math.min(...members.map(e=>e.y));
  const elements=structuredClone(members).map(e=>{e.x-=left;e.y-=top;delete e.componentId;delete e.instanceId;delete e.componentElementId;delete e.componentOverrides;delete e.anchors;return e;});
  const components=(c.settings??={}).designComponents??=[];c.settings.designComponents=components;
  const old=existingId?components.find(x=>x.id===existingId):undefined;if(existingId&&!old)throw new Error('组件不存在');
  // Slot IDs survive master updates when editing an existing instance.
  const slots=new Map(members.map(e=>[e.id,existingId&&e.componentId===existingId?(e.componentElementId??e.id):e.id]));
  elements.forEach((el,i)=>{el.id=slots.get(members[i].id)!;if(el.textGrowth?.shrinkImageId)el.textGrowth.shrinkImageId=slots.get(el.textGrowth.shrinkImageId)??el.textGrowth.shrinkImageId;});
  elements.forEach(el=>remapContainerRefs(el,slots));
  const component:DesignComponent={id:old?.id??id(),name:name.trim(),width:Math.max(1,...members.map(e=>e.x+e.width-left)),height:Math.max(1,...members.map(e=>e.y+e.height-top)),elements,revision:(old?.revision??0)+1};
  if(old)Object.assign(old,component);else components.push(component);
  return component;
}
export function insertComponent(c:ProjectContent,l:Layout,componentId:string,x:number,y:number,id:()=>string){
  const source=c.settings?.designComponents?.find(s=>s.id===componentId);if(!source)throw new Error('组件不存在');
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('位置必须为有限数值');
  const instance=id(),members=structuredClone(source.elements);const idMap=new Map(members.map(e=>[e.id,id()]));
  for(const el of members){const slot=el.id;el.id=idMap.get(slot)!;el.x+=x;el.y+=y;el.groupId=instance;el.componentId=source.id;el.instanceId=instance;el.componentElementId=slot;el.componentOverrides=[];
    remapContainerRefs(el,idMap);
    if(el.textGrowth?.shrinkImageId)el.textGrowth.shrinkImageId=idMap.get(el.textGrowth.shrinkImageId)??el.textGrowth.shrinkImageId;
  }
  l.elements.push(...members);return {instanceId:instance,ids:members.map(e=>e.id)};
}
export function syncComponent(c:ProjectContent,componentId:string,reset=false){
  const master=c.settings?.designComponents?.find(s=>s.id===componentId);if(!master)throw new Error('组件不存在');let affected=0;
  for(const l of layouts(c)){
    const groups=new Set(l.elements.filter(e=>e.componentId===componentId).map(e=>e.instanceId));
    for(const instance of groups){
      const members=l.elements.filter(e=>e.instanceId===instance&&e.componentId===componentId);if(members.some(e=>e.locked))throw new Error('组件含锁定实例，请先解锁后更新');
      const originX=Math.min(...members.map(e=>e.x)),originY=Math.min(...members.map(e=>e.y));
      // Keep live instance IDs and local overrides; new slots get stable IDs derived from the instance.
      const map=new Map(master.elements.map(slot=>[slot.id,members.find(e=>e.componentElementId===slot.id)?.id??`${instance}:${slot.id}`]));
      const replacement=master.elements.map(slot=>{const old=members.find(e=>e.componentElementId===slot.id);const next={...structuredClone(slot),id:map.get(slot.id)!,x:originX+slot.x,y:originY+slot.y,groupId:instance,componentId,instanceId:instance,componentElementId:slot.id,componentOverrides:reset?[]:old?.componentOverrides??[]};
        remapContainerRefs(next,map);
        if(next.textGrowth?.shrinkImageId)next.textGrowth.shrinkImageId=map.get(next.textGrowth.shrinkImageId)??next.textGrowth.shrinkImageId;
        if(old&&!reset)for(const key of old.componentOverrides??[])(next as any)[key]=structuredClone((old as any)[key]);return next;});
      const first=l.elements.findIndex(e=>e.instanceId===instance&&e.componentId===componentId);l.elements=l.elements.filter(e=>!(e.instanceId===instance&&e.componentId===componentId));l.elements.splice(first,0,...replacement);affected++;
    }
  }return affected;
}
export function anchorElement(l:Layout,e:LayoutElement,horizontal:ElementAnchors['horizontal'],vertical:ElementAnchors['vertical']):ElementAnchors{
  return {horizontal,vertical,referenceWidth:l.width,referenceHeight:l.height,left:e.x,right:l.width-e.x-e.width,top:e.y,bottom:l.height-e.y-e.height,centerX:e.x+e.width/2-l.width/2,centerY:e.y+e.height/2-l.height/2};
}
export function remapContainerRefs(el:LayoutElement,map:Map<string,string>){
  if(el.clipSourceId)el.clipSourceId=map.get(el.clipSourceId)??el.clipSourceId;
  if(el.fitContent)el.fitContent.ids=el.fitContent.ids.map(id=>map.get(id)??id);
  if(el.stackAfter)el.stackAfter.id=map.get(el.stackAfter.id)??el.stackAfter.id;
}
export function resolveDesignLayout(layout:Layout,measure?:(el:LayoutElement)=>number):Layout{
  if(!layout.flows?.length&&!layout.elements.some(e=>e.anchors||e.textGrowth||e.fitContent||e.stackAfter))return layout;
  const l=structuredClone(layout);
  for(const e of l.elements){const a=e.anchors;if(a){if(a.horizontal==='right')e.x=l.width-a.right-e.width;else if(a.horizontal==='center')e.x=l.width/2+a.centerX-e.width/2;else if(a.horizontal==='stretch'){e.x=a.left;e.width=Math.max(1,l.width-a.left-a.right);}
    if(a.vertical==='bottom')e.y=l.height-a.bottom-e.height;else if(a.vertical==='center')e.y=l.height/2+a.centerY-e.height/2;else if(a.vertical==='stretch'){e.y=a.top;e.height=Math.max(1,l.height-a.top-a.bottom);}}
  }
  for(const e of l.elements){
    if(e.kind==='text'&&e.textGrowth&&measure){const desired=Math.min(e.textGrowth.maxHeight,Math.max(e.height,measure(e)));let delta=desired-e.height;
      const image=l.elements.find(x=>x.id===e.textGrowth?.shrinkImageId);if(image){delta=Math.min(delta,Math.max(0,image.height-(e.textGrowth.minImageHeight??100)));image.height-=delta;e.y-=delta;}e.height+=delta;}
  }
  const done=new Set<string>(),visiting=new Set<string>();
  const stack=(e:LayoutElement)=>{if(done.has(e.id)||visiting.has(e.id))return;visiting.add(e.id);const previous=l.elements.find(x=>x.id===e.stackAfter?.id);if(previous&&!visiting.has(previous.id)){stack(previous);e.x=previous.x;e.y=previous.y+previous.height+(e.stackAfter?.gap??0);}visiting.delete(e.id);done.add(e.id);};
  l.elements.forEach(stack);
  for(const flow of l.flows??[]){let cursor=flow.direction==='vertical'?flow.y+flow.padding:flow.x+flow.padding;
    for(const id of flow.ids){const e=l.elements.find(e=>e.id===id);if(!e||e.hidden)continue;
      if(flow.direction==='vertical'){e.y=cursor;e.x=flow.x+flow.padding+(flow.align==='center'?(flow.width-flow.padding*2-e.width)/2:flow.align==='end'?flow.width-flow.padding*2-e.width:0);cursor+=e.height+flow.gap;}
      else{e.x=cursor;e.y=flow.y+flow.padding;cursor+=e.width+flow.gap;}}
  }
  for(const e of l.elements){if(!e.fitContent)continue;const members=l.elements.filter(x=>e.fitContent!.ids.includes(x.id)&&!x.hidden);if(!members.length)continue;const p=e.fitContent.padding;const left=Math.min(...members.map(x=>x.x)),top=Math.min(...members.map(x=>x.y));e.x=left-p;e.y=top-p;e.width=Math.max(...members.map(x=>x.x+x.width))-left+p*2;e.height=Math.max(...members.map(x=>x.y+x.height))-top+p*2;}
  return l;
}

/** Small arithmetic parser: no eval, property access or executable expressions. */
export function designNumber(raw:string,unit:'px'|'mm'='px',pixelsPerMm=300/25.4):number{
  const text=raw.trim().replace(/\s+/g,'');const tokens=text.match(/\d*\.?\d+|[()+\-*/]/g)??[];
  if(tokens.join('')!==text||!tokens.length)throw new Error('请输入数字或四则运算');let i=0;
  const atom=():number=>{if(tokens[i]==='-'){i++;return -atom();}if(tokens[i]==='+'){i++;return atom();}if(tokens[i]==='('){i++;const n=sum();if(tokens[i++]!==')')throw new Error('括号不匹配');return n;}const n=Number(tokens[i++]);if(!Number.isFinite(n))throw new Error('无效数字');return n;};
  const product=():number=>{let n=atom();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],rhs=atom();n=op==='*'?n*rhs:n/rhs;}return n;};
  const sum=():number=>{let n=product();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],rhs=product();n=op==='+'?n+rhs:n-rhs;}return n;};
  const n=sum();if(i!==tokens.length||!Number.isFinite(n))throw new Error('无效算式');return unit==='mm'?n*pixelsPerMm:n;
}
export function saveFlow(l:Layout,flow:LayoutFlow){
  selectElements(l,flow.ids);if(new Set(flow.ids).size!==flow.ids.length)throw new Error('自动布局不能包含重复元素');
  if(!['horizontal','vertical'].includes(flow.direction)||![flow.x,flow.y,flow.width,flow.gap,flow.padding].every(Number.isFinite)||flow.width<=0||flow.padding<0||flow.gap<0)throw new Error('自动布局参数无效');
  if(l.flows?.some(f=>f.id!==flow.id&&f.ids.some(id=>flow.ids.includes(id))))throw new Error('同一元素只能加入一个自动布局');
  l.flows=[...(l.flows??[]).filter(f=>f.id!==flow.id),structuredClone(flow)];
}
