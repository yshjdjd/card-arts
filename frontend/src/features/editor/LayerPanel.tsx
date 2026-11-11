import React, { useState } from 'react';
import type { LayoutElement } from '../../lib/types';
import type { LayerCommand } from '../../lib/layers';
import {pickLayers} from '../../lib/layerSelection';

export default function LayerPanel({elements,selected,onSelect,onCommand}:{elements:LayoutElement[];selected:string[];onSelect:(ids:string[])=>void;onCommand:(command:LayerCommand)=>void}) {
  const [query,setQuery]=useState(''),[collapsed,setCollapsed]=useState<string[]>([]),[editing,setEditing]=useState<string|null>(null);
  const [name,setName]=useState('');
  const [anchor,setAnchor]=useState<string|null>(null);
  const visible=elements.slice().reverse().filter(e=>(!e.groupId||!collapsed.includes(e.groupId)||!!query)&&`${e.name} ${e.id} ${e.groupName??''}`.toLowerCase().includes(query.toLowerCase()));
  const groups=[...new Set(elements.map(e=>e.groupId).filter(Boolean))] as string[];
  const command=(operation:LayerCommand['operation'],ids=selected,extra:Partial<LayerCommand>={})=>onCommand({operation,ids,...extra});
  const pick=(el:LayoutElement,e:React.MouseEvent)=>{
    onSelect(pickLayers(elements,visible.map(x=>x.id),selected,el.id,anchor,{range:e.shiftKey,toggle:e.ctrlKey||e.metaKey,singleMember:e.altKey}));
    if(!e.shiftKey)setAnchor(el.id);
  };
  return <div className="pb" style={{overflowY:'auto'}}>
    <input className="input" aria-label="搜索图层" placeholder="搜索图层名称 / ID" value={query} onChange={e=>setQuery(e.target.value)} />
    <div className="row wrap mt8" style={{gap:4}}>{([['front','置顶'],['up','上移'],['down','下移'],['back','置底'],['show','显示'],['hide','隐藏'],['lock','锁定'],['unlock','解锁'],['group','组合'],['ungroup','解组']] as const).map(([op,label])=><button key={op} className="btn sm" disabled={!selected.length||(op==='group'&&selected.length<2)} onClick={()=>command(op)}>{label}</button>)}</div>
    <div className="row wrap mt8" style={{gap:4}}><button className="btn sm" disabled={!visible.length} onClick={()=>onSelect(visible.map(e=>e.id))}>全选可见项</button><button className="btn sm" disabled={!selected.length} onClick={()=>{onSelect([]);setAnchor(null);}}>取消选择</button></div>
    <div className="small faint mt8">已选 {selected.length} / {elements.length} · 勾选框逐层多选，Ctrl/⌘ 点击切换，Shift 连选，Alt 选组内成员。选好后点“组合”。上方覆盖下方。</div>
    {groups.map(group=>{const members=elements.filter(e=>e.groupId===group);return <div key={group} className="row small mt8" style={{gap:4}}>
      <button className="btn ghost sm" aria-label={`折叠组 ${group}`} onClick={()=>setCollapsed(collapsed.includes(group)?collapsed.filter(g=>g!==group):[...collapsed,group])}>{collapsed.includes(group)?'▸':'▾'}</button>
      <button className="btn ghost sm" onClick={()=>onSelect(members.map(e=>e.id))}>{members.find(e=>e.groupName)?.groupName||'未命名组'}（{members.length}）</button>
      <button className="iconbtn" aria-label="重命名组" title="重命名组" onClick={()=>{const value=window.prompt('组名称',members.find(e=>e.groupName)?.groupName||'未命名组');if(value?.trim())command('renameGroup',members.map(e=>e.id),{name:value.trim()});}}>✎</button>
      <button className="iconbtn" title="切换整组可见性" onClick={()=>command(members.every(e=>e.hidden)?'show':'hide',members.map(e=>e.id))}>👁</button>
      <button className="iconbtn" title="切换整组锁定" onClick={()=>command(members.every(e=>e.locked)?'unlock':'lock',members.map(e=>e.id))}>🔒</button>
    </div>;})}
    {visible.map(el=><div key={el.id} className={`layer ${selected.includes(el.id)?'sel':''}`} role="option" aria-selected={selected.includes(el.id)}
      draggable={!el.locked&&editing!==el.id} onDragStart={e=>{const ids=selected.includes(el.id)?selected:[el.id];e.dataTransfer.setData('application/cardarts-layers',JSON.stringify(ids));onSelect(ids);}}
      onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();try{const ids=JSON.parse(e.dataTransfer.getData('application/cardarts-layers'));if(Array.isArray(ids)&&!ids.includes(el.id))command('above',ids,{target:el.id});}catch{/* unrelated drag */}}}
      onClick={e=>pick(el,e)}>
      <input type="checkbox" aria-label={`选择图层 ${el.name}`} checked={selected.includes(el.id)} onClick={e=>e.stopPropagation()} onChange={()=>{onSelect(pickLayers(elements,visible.map(x=>x.id),selected,el.id,anchor,{toggle:true,singleMember:true}));setAnchor(el.id);}}/>
      <span title={el.kind}>{el.groupId?'▣':el.kind==='text'?'T':el.kind==='image'?'🖼':'◇'}</span>
      {editing===el.id?<input className="input" autoFocus value={name} aria-label="图层名称" onClick={e=>e.stopPropagation()} onChange={e=>setName(e.target.value)} onBlur={()=>{if(name.trim()&&name!==el.name)command('rename',[el.id],{name,expandGroups:false});setEditing(null);}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape')setEditing(null);}} />:
        <span className="nm" title={`${el.name} [${el.id}]；双击重命名`} onDoubleClick={e=>{e.stopPropagation();if(!el.locked){setEditing(el.id);setName(el.name);}}}>{el.name}</span>}
      <button className="iconbtn" aria-label={`${el.hidden?'显示':'隐藏'}图层 ${el.name}`} onClick={e=>{e.stopPropagation();command(el.hidden?'show':'hide',[el.id],{expandGroups:false});}}>{el.hidden?'🚫':'👁'}</button>
      <button className="iconbtn" aria-label={`${el.locked?'解锁':'锁定'}图层 ${el.name}`} onClick={e=>{e.stopPropagation();command(el.locked?'unlock':'lock',[el.id],{expandGroups:false});}}>{el.locked?'🔒':'🔓'}</button>
    </div>)}
    {!elements.length&&<div className="small faint mt8">尚无图层，请添加元素</div>}
  </div>;
}
