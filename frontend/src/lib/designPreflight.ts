import { renderLayout, type ImageLike } from './render';
import { collectRefs, loadImage } from './useImages';
import { projectFontSources } from './projectFonts';
import { loadFontSources } from './fontRuntime';
import { db } from '../db/schema';
import { api, assetUrl } from '../api/client';
import type { Deck, ProjectContent } from './types';

export interface DesignIssue {cardIndex:number;cardId:string;elementId:string;message:string}
function luminance(color:string){if(!/^#[\da-f]{6}$/i.test(color))return null;const parts=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722;}
export function checkDesignCard(content:ProjectContent,deck:Deck,side:'front'|'back',index:number,images:Record<string,ImageLike>,icons:Record<string,ImageLike>):DesignIssue[]{
  const layout=side==='front'?deck.frontLayout:deck.backLayout;if(!layout)return [];
  const card=deck.cards[index]??null,issues:{elementId:string;message:string}[]=[];
  const ctx=document.createElement('canvas').getContext('2d')!;
  renderLayout(ctx,layout,card,{scale:1,values:card?.values??{},images,icons,diagnostics:issues},deck.fields);
  for(const e of layout.elements){if(e.hidden)continue;
    if(e.styleId&&!content.settings?.designStyles?.some(s=>s.id===e.styleId))issues.push({elementId:e.id,message:'共享样式引用不存在'});
    if(e.componentId&&!content.settings?.designComponents?.some(c=>c.id===e.componentId))issues.push({elementId:e.id,message:'组件主定义不存在'});
    if(e.fieldId&&!deck.fields.some(f=>f.id===e.fieldId))issues.push({elementId:e.id,message:'绑定字段不存在'});
    for(const id of [e.countFieldId,e.countSlotsFieldId].filter(Boolean))if(!deck.fields.some(f=>f.id===id&&f.type==='number'))issues.push({elementId:e.id,message:'数量或总格数绑定的数字字段不存在'});
    if(e.kind==='text'&&!e.gradient){
      const imageBehind=layout.elements.slice(0,layout.elements.indexOf(e)).some(b=>b.kind==='image'&&!b.hidden&&b.x<=e.x&&b.y<=e.y&&b.x+b.width>=e.x+e.width&&b.y+b.height>=e.y+e.height);
      if(imageBehind)continue;
      const bg=layout.elements.slice(0,layout.elements.indexOf(e)).reverse().find(b=>b.kind==='rectangle'&&!b.hidden&&!b.gradient&&!b.rotation&&(b.fillOpacity??1)===1&&b.x<=e.x&&b.y<=e.y&&b.x+b.width>=e.x+e.width&&b.y+b.height>=e.y+e.height);
      const behind=bg?.fill??layout.backgroundColor;const a=luminance(e.color),b=luminance(behind);
      if(a!==null&&b!==null&&(Math.max(a,b)+.05)/(Math.min(a,b)+.05)<3)issues.push({elementId:e.id,message:'文字与背景对比偏低（仅纯色估算）'});
    }
  }
  for(const flow of layout.flows??[])if(flow.ids.some(id=>!layout.elements.some(e=>e.id===id)))issues.push({elementId:flow.ids[0]??'',message:'自动布局引用已删除元素'});
  return issues.map(issue=>({...issue,cardIndex:index,cardId:card?.id??''}));
}

export async function preflightProject(content:ProjectContent,deck:Deck,side:'front'|'back',assets:{id:string;url:string;mime:string}[],signal?:AbortSignal){
  const layout=side==='front'?deck.frontLayout:deck.backLayout;if(!layout)throw new Error('版式不存在');
  const refs=collectRefs([layout],deck.cards,deck.fields),images:Record<string,ImageLike>={},icons:Record<string,ImageLike>={},urls:string[]=[],errors:string[]=[];
  try{
    try{await loadFontSources(await projectFontSources([layout],assets as any));}catch(e){errors.push('字体加载失败：'+(e as Error).message);}
    await Promise.all(refs.assets.map(async id=>{let row=assets.find(a=>a.id===id),url=row?.url??'';
      if(!url){const local=await db.assets.get(id);if(local?.blob){url=URL.createObjectURL(local.blob);urls.push(url);}}
      if(url){try{const img=await loadImage(assetUrl(url),row?.mime==='image/svg+xml');if(img)images[id]=img;}catch{/* renderer reports missing asset */}}
    }));
    await Promise.all(refs.icons.map(async id=>{try{const image=await loadImage(api.iconSvgUrl(id),true);if(image)icons[id]=image;}catch{/* missing icon is reported */}}));
    const issues:DesignIssue[]=[];
    for(let i=0;i<Math.max(1,deck.cards.length);i++){
      if(signal?.aborted)throw new DOMException('aborted','AbortError');
      issues.push(...checkDesignCard(content,deck,side,i,images,icons));
      if(i%20===0)await new Promise(r=>setTimeout(r,0));
    }
    return {checkedCards:Math.max(1,deck.cards.length),issueCount:issues.length,resourceErrors:errors,issues:issues.slice(0,500),notice:issues.length>500?'仅展示前500项':'检查不代替印厂打样；字体缺字需实际校对'};
  }finally{urls.forEach(url=>URL.revokeObjectURL(url));}
}
