import React, { useRef, useState } from 'react';
import { useProject } from '../../state/store';
import { uid } from '../../lib/utils';

export default function RichTextEditor({value,onChange,rich,onCompositionStart,onCompositionEnd,onBlur,autoFocus=false,label}:{value:string;onChange:(text:string)=>void;rich:boolean;onCompositionStart?:()=>void;onCompositionEnd?:(value:string)=>void;onBlur?:()=>void;autoFocus?:boolean;label?:string}){
  const {content,update}=useProject();const ref=useRef<HTMLTextAreaElement>(null),range=useRef({start:0,end:0});
  const [color,setColor]=useState('#dc2626'),[size,setSize]=useState(32),[name,setName]=useState('');
  const snippets=(Array.isArray(content.settings?.textSnippets)?content.settings.textSnippets:[]) as {id:string;name:string;text:string}[];
  const insert=(prefix:string,suffix='',replace?:string)=>{const {start,end}=range.current;const selected=value.slice(start,end)||'文字';const text=prefix+(replace??selected)+suffix;onChange(value.slice(0,start)+text+value.slice(end));requestAnimationFrame(()=>{ref.current?.focus();ref.current?.setSelectionRange(start+prefix.length,start+text.length-suffix.length);});};
  return <div style={{width:'100%'}}>
    {rich&&<div className="row wrap" style={{gap:4,marginBottom:6}}>
      <button className="btn sm" title="加粗选中文字" onMouseDown={e=>e.preventDefault()} onClick={()=>insert('**','**')}>B</button>
      <button className="btn sm" title="斜体选中文字" onMouseDown={e=>e.preventDefault()} onClick={()=>insert('*','*')}>I</button>
      <input type="color" aria-label="选中文字颜色" value={color} onChange={e=>setColor(e.target.value)} style={{width:28}}/>
      <button className="btn sm" onMouseDown={e=>e.preventDefault()} onClick={()=>insert(`[color=${color}]`,'[/color]')}>着色</button>
      <input className="input" type="number" min={4} max={300} value={size} style={{width:60}} onChange={e=>setSize(Number(e.target.value))}/>
      <button className="btn sm" onMouseDown={e=>e.preventDefault()} onClick={()=>insert(`[size=${size}]`,'[/size]')}>字号</button>
    </div>}
    <textarea ref={ref} aria-label={label??'文本内容'} autoFocus={autoFocus} onCompositionStart={onCompositionStart} onCompositionEnd={e=>onCompositionEnd?.(e.currentTarget.value)} onBlur={onBlur} className="input" rows={4} value={value} onSelect={e=>{range.current={start:e.currentTarget.selectionStart,end:e.currentTarget.selectionEnd};}} onChange={e=>onChange(e.target.value)}/>
    <details className="small mt8"><summary>复用规则片段</summary><select className="select" value="" onChange={e=>{const item=snippets.find(s=>s.id===e.target.value);if(item)insert('','',item.text);}}><option value="">插入项目规则片段…</option>{snippets.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><input className="input mt8" value={name} placeholder="片段名称" onChange={e=>setName(e.target.value)}/><button className="btn sm mt8" disabled={!name.trim()||!value.trim()} onClick={()=>{const text=value.slice(range.current.start,range.current.end)||value;void update(c=>{(c.settings??={}).textSnippets=[...snippets,{id:uid(),name:name.trim(),text}];},'保存规则片段');setName('');}}>保存选中内容或全文</button></details>
  </div>;
}
