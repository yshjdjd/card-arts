import type {LayoutElement} from './types';

/** 范围选择按图层栏当前可见顺序；Ctrl/Command 切换，Alt 单选组内成员。 */
export function pickLayers(elements:LayoutElement[],visibleIds:string[],selected:string[],id:string,anchor:string|null,
  options:{range?:boolean;toggle?:boolean;singleMember?:boolean}={}){
 const el=elements.find(e=>e.id===id);if(!el)return selected;
 const expand=(ids:string[])=>[...new Set(ids.flatMap(key=>{const item=elements.find(e=>e.id===key);return item?.groupId&&!options.singleMember?elements.filter(e=>e.groupId===item.groupId).map(e=>e.id):[key];}))];
 if(options.range&&anchor&&visibleIds.includes(anchor)&&visibleIds.includes(id)){
  const a=visibleIds.indexOf(anchor),b=visibleIds.indexOf(id),range=expand(visibleIds.slice(Math.min(a,b),Math.max(a,b)+1));
  return [...new Set([...selected,...range])];
 }
 const ids=expand([id]);
 return options.toggle?(ids.every(key=>selected.includes(key))?selected.filter(key=>!ids.includes(key)):[...new Set([...selected,...ids])]):ids;
}
