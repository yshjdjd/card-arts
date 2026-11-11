import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/ui';
import { allCardTemplates, instantiateTemplate, TEMPLATE_THEMES, type CardTemplate, type TemplateOptions } from '../../lib/cardTemplates';
import { useAssets } from '../../state/store';
import { useLayoutImages } from '../../lib/useImages';
import type { ImageLike } from '../../lib/render';
import { CARD_PRESETS } from '../../lib/presets';
import { renderToCanvas } from '../../lib/render';
import type { Deck, Layout, ProjectContent } from '../../lib/types';

function Preview({layout,values,images,icons}:{layout:Layout|null;values:Record<string,unknown>;images:Record<string,ImageLike>;icons:Record<string,ImageLike>}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{if(!layout||!canvas.current)return;const image=renderToCanvas(layout,{id:'preview',values},{values,images,icons,scale:Math.min(220/layout.width,300/layout.height),placeholders:true});canvas.current.width=image.width;canvas.current.height=image.height;canvas.current.getContext('2d')?.drawImage(image,0,0);},[layout,values,images,icons]);
  return <canvas ref={canvas} aria-label="模板版式预览" style={{maxWidth:'100%',maxHeight:300,borderRadius:8}}/>;
}
export default function TemplateLibrary({content,deck,onClose,onApply,onSave}:{content:ProjectContent;deck:Deck;onClose:()=>void;onApply:(template:CardTemplate,options:TemplateOptions,newDeck:boolean,name:string)=>Promise<void>;onSave:(name:string)=>Promise<void>}){
  const templates=allCardTemplates(content);
  const [selected,setSelected]=useState(templates[0].id),[query,setQuery]=useState(''),[theme,setTheme]=useState('parchment'),[preset,setPreset]=useState(''),[side,setSide]=useState<'front'|'back'|'both'>('both'),[newDeck,setNewDeck]=useState(true),[name,setName]=useState(''),[mapping,setMapping]=useState<Record<string,string>>({}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[customName,setCustomName]=useState('');
  const template=templates.find(t=>t.id===selected)??templates[0];
  const options:TemplateOptions={theme,preset:preset||undefined,side,mapping,font:typeof content.settings?.defaultFont==='string'?content.settings.defaultFont:undefined};
  const plan=useMemo(()=>{
    try{let n=0;const base=newDeck?{...deck,fields:[{id:'name',name:'名称',type:'text' as const},{id:'count',name:'数量',type:'number' as const}],cards:[],frontLayout:null,backLayout:null}:deck;
      return {result:instantiateTemplate(template,base,options,()=>`preview-${++n}`),error:''};
    }catch(e){return {result:null,error:(e as Error).message};}
  },[template,deck,newDeck,theme,preset,side,mapping,content.settings?.defaultFont]);
  const previewValues=useMemo(()=>{const result:Record<string,unknown>={};for(const f of plan.result?.deck.fields??[])result[f.id]=f.type==='number'?3:f.type==='image'?'':f.name==='名称'?template.name:f.name==='描述'?'在此编写卡牌规则，支持字段绑定与自动适配字号。':f.name==='花色'?'♠':f.name==='步骤说明'?'1. 准备资源\n2. 执行行动\n3. 结算效果':f.name;return {...result,...(!newDeck?deck.cards[0]?.values:{})};},[plan.result,template.name,deck.cards,newDeck]);
  const {assets}=useAssets();
  const {images,icons,error:previewError}=useLayoutImages([plan.result?.deck.frontLayout,plan.result?.deck.backLayout],assets,[{id:'preview',values:previewValues}],plan.result?.deck.fields??[]);
  const run=async(fn:()=>Promise<void>)=>{setSaving(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setSaving(false);}};
  return <Modal wide title="卡牌模板库" onClose={()=>{if(!saving)onClose();}} footer={<><button className="btn" disabled={saving} onClick={onClose}>关闭</button><button className="btn primary" disabled={saving||!!plan.error} onClick={()=>void run(()=>onApply(template,options,newDeck,name||template.name))}>{saving?'处理中…':newDeck?'用此模板新建牌组':'替换所选面的版式'}</button></>}>
    <div className="small faint">原创通用版式 · 文字/插图保持字段绑定 · 所有图层可继续编辑。应用当前牌组前会确认，卡牌数据保留。</div>
    <input className="input mt8" aria-label="搜索卡牌模板" placeholder="搜索名称、类型或标签" value={query} onChange={e=>setQuery(e.target.value)}/>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:6,marginTop:8}}>{templates.filter(t=>`${t.name} ${t.category} ${t.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())).map(t=><button key={t.id} className={`btn ${selected===t.id?'primary':''}`} onClick={()=>{setSelected(t.id);setMapping({});setError('');}}>{t.name}</button>)}</div>
    <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:12}}>
      <div style={{minWidth:180,flex:'0 0 220px'}}>{plan.result&&<Preview layout={side==='back'?plan.result.deck.backLayout:plan.result.deck.frontLayout} values={previewValues} images={images} icons={icons}/>}<div className="small mt8">{template.description}</div>{template.custom&&<div className="small faint">项目模板的图片与字体依赖本项目素材；配色沿用保存值。</div>}</div>
      <div style={{flex:1,minWidth:220}}>
        <label className="lbl">应用方式<select className="select" value={newDeck?'new':'existing'} onChange={e=>{setNewDeck(e.target.value==='new');setMapping({});}}><option value="new">新建牌组（保留当前牌组）</option><option value="existing">应用到当前牌组：{deck.name}</option></select></label>
        {newDeck&&<input className="input mt8" placeholder={`新牌组名称，默认 ${template.name}`} value={name} onChange={e=>setName(e.target.value)}/>}
        <label className="lbl mt8">尺寸<select className="select" value={preset} onChange={e=>setPreset(e.target.value)}><option value="">{newDeck?'模板推荐尺寸':'保留当前尺寸'}</option>{CARD_PRESETS.map(p=><option key={p.key} value={p.key}>{p.name} · {p.widthMm}×{p.heightMm} mm</option>)}</select></label>
        <label className="lbl mt8">配色<select className="select" disabled={template.custom} value={theme} onChange={e=>setTheme(e.target.value)}>{Object.entries(TEMPLATE_THEMES).map(([id,t])=><option key={id} value={id}>{t.name}</option>)}</select></label>
        <label className="lbl mt8">应用面<select className="select" value={side} onChange={e=>setSide(e.target.value as typeof side)}><option value="both">正面与牌背</option><option value="front">仅正面</option><option value="back">仅牌背</option></select></label>
        {!newDeck&&<details className="small mt8"><summary>字段映射（自动匹配或补建）</summary>{template.fields.map(f=><label key={f.id} style={{display:'block'}}>{f.name}<select className="select" value={mapping[f.id]??''} onChange={e=>setMapping({...mapping,[f.id]:e.target.value})}><option value="">自动匹配 / 缺失时新增</option>{deck.fields.filter(x=>x.type===f.type||(f.type==='text'&&x.type==='select')).map(x=><option key={x.id} value={x.id}>{x.name} [{x.id}]</option>)}</select></label>)}</details>}
        <div className="small mt8">将新增字段：{plan.result?.added.map(f=>f.name).join('、')||'无'}。不会删除现有字段或卡牌。</div>
        {previewError&&<div className="small faint">素材预览：{previewError}</div>}{(plan.error||error)&&<div role="alert" className="small mt8">{plan.error||error}</div>}
      </div>
    </div>
    <details className="mt8"><summary>将当前牌组保存为项目模板</summary><input className="input" placeholder="模板名称" value={customName} onChange={e=>setCustomName(e.target.value)}/><button className="btn sm mt8" disabled={saving||!customName.trim()} onClick={()=>void run(async()=>{await onSave(customName);setCustomName('');})}>保存模板</button></details>
  </Modal>;
}
