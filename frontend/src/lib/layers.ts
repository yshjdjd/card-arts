import type { LayoutElement } from './types';

export type LayerOperation = 'front'|'back'|'up'|'down'|'above'|'below'|'order'|'rename'|'renameGroup'|'show'|'hide'|'lock'|'unlock'|'group'|'ungroup';
export interface LayerCommand {operation:LayerOperation;ids:string[];target?:string;name?:string;order?:string[];groupId?:string;expandGroups?:boolean}
export function listLayers(elements:LayoutElement[]) {
  return elements.map((e,index)=>({id:e.id,name:e.name,kind:e.kind,index,hidden:!!e.hidden,locked:!!e.locked,groupId:e.groupId??null,groupName:e.groupName??null})).reverse();
}
/** Storage is bottom-to-top. All validation precedes mutation. */
export function applyLayers(elements:LayoutElement[], command:LayerCommand):LayoutElement[] {
  const known=new Set(elements.map(e=>e.id));
  if(known.size!==elements.length)throw new Error('图层 ID 重复，请先修复版式');
  const operations=['front','back','up','down','above','below','order','rename','renameGroup','show','hide','lock','unlock','group','ungroup'];
  if(!operations.includes(command.operation))throw new Error('未知图层操作');
  let ids=new Set(command.ids);
  if(command.operation!=='order'&&(!ids.size||[...ids].some(id=>!known.has(id))))throw new Error('请提供当前版式真实图层 ID');
  if((command.expandGroups!==false||command.operation==='renameGroup')&&command.operation!=='rename'){
    const groups=new Set(elements.filter(e=>ids.has(e.id)&&e.groupId).map(e=>e.groupId));
    elements.filter(e=>e.groupId&&groups.has(e.groupId)).forEach(e=>ids.add(e.id));
  }
  const editable=['show','hide','lock','unlock'].includes(command.operation);
  if(!editable&&elements.some(e=>e.locked&&(ids.has(e.id)||(command.operation==='order'&&command.order?.indexOf(e.id)!==elements.indexOf(e)))))throw new Error('所选图层已锁定，请先解锁');
  const copy=structuredClone(elements);
  const selected=copy.filter(e=>ids.has(e.id)), rest=copy.filter(e=>!ids.has(e.id));
  switch(command.operation){
    case 'order': {
      const order=command.order??[];
      if(order.length!==copy.length||new Set(order).size!==copy.length||order.some(id=>!known.has(id)))throw new Error('order 必须完整且不重复，顺序为底层到顶层');
      return order.map(id=>copy.find(e=>e.id===id)!);
    }
    case 'front':return [...rest,...selected];
    case 'back':return [...selected,...rest];
    case 'up':
      for(let i=copy.length-2;i>=0;i--)if(ids.has(copy[i].id)&&!ids.has(copy[i+1].id))[copy[i],copy[i+1]]=[copy[i+1],copy[i]];
      return copy;
    case 'down':
      for(let i=1;i<copy.length;i++)if(ids.has(copy[i].id)&&!ids.has(copy[i-1].id))[copy[i],copy[i-1]]=[copy[i-1],copy[i]];
      return copy;
    case 'above':case 'below': {
      const target=rest.findIndex(e=>e.id===command.target);
      if(target<0)throw new Error('目标必须是所选图层之外的真实 ID');
      rest.splice(target+(command.operation==='above'?1:0),0,...selected);return rest;
    }
    case 'renameGroup': {
      const groups=new Set(selected.map(e=>e.groupId));
      if(groups.size!==1||!selected[0]?.groupId||!command.name?.trim())throw new Error('请选择同一组的成员并提供非空组名');
      selected.forEach(e=>{e.groupName=command.name!.trim().slice(0,120);});break;
    }
    case 'rename':
      if(selected.length!==1||!command.name?.trim())throw new Error('重命名需一个图层和非空 name');
      selected[0].name=command.name.trim().slice(0,120);break;
    case 'show':case 'hide':selected.forEach(e=>{e.hidden=command.operation==='hide';});break;
    case 'lock':case 'unlock':selected.forEach(e=>{e.locked=command.operation==='lock';});break;
    case 'group':
      if(selected.length<2||!command.groupId)throw new Error('组合至少需要两个图层');
      selected.forEach(e=>{e.groupId=command.groupId;e.groupName=command.name?.trim().slice(0,120)||'未命名组';});break;
    case 'ungroup':selected.forEach(e=>{delete e.groupId;delete e.groupName;});break;
  }
  return copy;
}
