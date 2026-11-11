import React from 'react';
import { useConfirm } from '../../components/ui';
import { AssetField } from '../../components/AssetPicker';
import RichTextEditor from './RichTextEditor';
import type { Card, Deck, Field, Layout } from '../../lib/types';
import { CardDrafts, cardDraftKey } from '../../lib/cardDrafts';

export function CardFieldInput({field,value,rich,onChange,onPause,onBlur,autoFocus=false}:{field:Field;value:unknown;rich:boolean;onChange:(value:unknown)=>void;onPause:(on:boolean)=>void;onBlur:()=>void;autoFocus?:boolean}){
  if(field.type==='image')return <AssetField value={String(value??'')} onChange={onChange} label={`为当前卡牌选择${field.name}`}/>;
  if(field.type==='boolean')return <label className="row small"><input type="checkbox" checked={value===true||value==='true'||value===1} onChange={e=>onChange(e.target.checked)}/>{field.name}</label>;
  if(field.type==='select')return <select className="select" aria-label={field.name} autoFocus={autoFocus} value={String(value??'')} onChange={e=>onChange(e.target.value)} onBlur={onBlur}><option value="">未设置</option>{!!value&&!field.options?.includes(String(value))&&<option value={String(value)}>原值：{String(value)}</option>}{(field.options??[]).map(option=><option key={option} value={option}>{option}</option>)}</select>;
  if(field.type==='color')return <div className="row" style={{gap:8}}><input className="input" type="color" aria-label={field.name} value={/^#[\da-f]{6}$/i.test(String(value))?String(value):'#000000'} onChange={e=>onChange(e.target.value)} onBlur={onBlur}/><span className="small">{String(value??'')}</span></div>;
  if(field.type==='number')return <input className="input" type="number" min={field.id==='count'?0:undefined} step={field.id==='count'?1:'any'} aria-label={field.name} autoFocus={autoFocus} value={typeof value==='number'||typeof value==='string'?value:''} onChange={e=>{const raw=e.target.value;onChange(raw===''?'':Number(raw));}} onBlur={onBlur} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/>;
  return <RichTextEditor label={field.name} value={String(value??'')} rich={rich} onChange={onChange} autoFocus={autoFocus} onCompositionStart={()=>onPause(true)} onCompositionEnd={text=>{onChange(text);onPause(false);}} onBlur={onBlur}/>;
}

export default function CardFieldEditor({deck,card,layout,drafts,onNewCard,onEnableRich,highlight}:{deck:Deck;card:Card|null;layout:Layout|null;drafts:CardDrafts;onNewCard:()=>void;onEnableRich:(field:string,on:boolean)=>void;highlight?:string}){
  const [confirmNode,ask]=useConfirm();
  const key=card?cardDraftKey(deck.id,card.id):'';
  const status=drafts.status(key);
  return <section style={{padding:12,borderBottom:'1px solid var(--border)'}}>
    <b>当前卡牌数据</b><div className="small faint mt8">修改仅作用于当前卡牌；位置、字体等版式属性仍影响整个牌组。</div>
    {drafts.failures().filter(e=>e.key!==key).map(failed=><details key={failed.key} className="small danger mt8"><summary>其他卡牌有未保存草稿：{failed.error}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(failed.values,null,2)}</pre><button className="btn sm" onClick={()=>void drafts.flush(failed.key)}>重试保存</button><button className="btn ghost sm" onClick={()=>{void ask({title:'丢弃未保存草稿',text:'请先复制需要保留的内容。确认丢弃这份未保存草稿？',danger:true}).then(ok=>{if(ok)void drafts.discard(failed.key);});}}>丢弃此草稿</button></details>)}
    {!card?<div className="mt8"><div className="small">还没有卡牌，请先创建。</div><button className="btn sm primary mt8" onClick={onNewCard}>新建卡牌并编辑</button></div>:<>
      <div className="row mt8" style={{gap:6}}><span className="small" role="status">{({saved:'已保存',pending:'待保存…',saving:'正在保存…',composing:'中文输入中…',error:'保存失败，草稿保留'})[status]}</span><button className="btn ghost sm" onClick={()=>void drafts.flush(key)}>{status==='error'?'重试保存':'立即保存'}</button></div>
      {drafts.error(key)&&<div className="small danger" role="alert">{drafts.error(key)}<button className="btn ghost sm" onClick={()=>{void ask({title:'丢弃未保存草稿',text:'仅丢弃此卡尚未保存的输入，已保存修改不受影响。',danger:true}).then(ok=>{if(ok)void drafts.discard(key);});}}>丢弃未保存草稿</button></div>}
      {deck.fields.map(field=>{const bound=layout?.elements.filter(el=>el.kind==='text'&&el.fieldId===field.id)??[];const rich=bound.some(el=>el.richText);return <details key={field.id} open={highlight===field.id||undefined} className="mt8">
        <summary className="small">{field.name} · {field.type}{highlight===field.id?' · 所选元素绑定':''}</summary>
        <div className="mt8"><CardFieldInput key={`${card.id}:${field.id}`} field={field} value={card.values[field.id]} rich={rich} onChange={value=>drafts.edit(key,field.id,value)} onPause={on=>drafts.pause(key,field.id,on)} onBlur={()=>void drafts.flush(key)}/></div>
        {field.type==='text'&&!!bound.length&&<label className="small faint"><input type="checkbox" checked={rich} onChange={e=>onEnableRich(field.id,e.target.checked)}/> 此版式按富文本显示（所有卡牌）</label>}
      </details>;})}
    </>}{confirmNode}
  </section>;
}
