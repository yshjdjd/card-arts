import React, {useState} from 'react';
import { SHAPES } from '../../lib/shapes';
import type {LayoutElement} from '../../lib/types';

export async function importVectorSvg(file:File):Promise<Partial<LayoutElement>> {
      if(file.size>1024*1024)throw new Error('SVG 文件不能超过 1 MB');
      const doc=new DOMParser().parseFromString(await file.text(),'image/svg+xml');
      const root=doc.documentElement;
      if(root.localName!=='svg'||doc.querySelector('parsererror'))throw new Error('不是有效的 SVG 文件');
      if(doc.querySelector('[transform],use,text,image,rect,circle,ellipse,polygon,polyline,line,clipPath,mask'))throw new Error('请先在矢量软件中将图形转换为路径并应用变换，再导入；当前支持纯 path 轮廓 SVG');
      const paths=[...doc.querySelectorAll('path')].filter(p=>!p.closest('defs'));
      const d=paths.map(p=>p.getAttribute('d')||'').join(' ');
      if(!d.trim())throw new Error('SVG 中没有路径');
      const box=(root.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
      if(box.length!==4||box.some(n=>!Number.isFinite(n))||box[2]<=0||box[3]<=0)throw new Error('SVG 需要有效的 viewBox');
      new Path2D(d);
      return {kind:"path",shapePath:d,pathViewBox:box as [number,number,number,number],name:file.name.replace(/\.svg$/i,"")};
}

export default function VectorPathEditor({element,onPatch}:{element:LayoutElement;onPatch:(p:Partial<LayoutElement>)=>void}) {
  const [error,setError]=useState('');
  const presets=SHAPES.filter((s):s is typeof s & {path:string}=>'path' in s);
  const vb=element.pathViewBox??[0,0,100,100];
  const load=async(file:File)=>{try{onPatch(await importVectorSvg(file));setError('');}catch(e){setError((e as Error).message);}};
  return <div>
    <div className="small faint">选择轮廓后，可在下方调整填充、描边；拖动图层边框调整大小。</div>
    <div className="row wrap" style={{gap:6,margin:'8px 0'}}>{presets.map(s=><button className="btn sm" key={s.id} title={s.name} onClick={()=>{onPatch({shapePath:s.path,pathViewBox:[0,0,100,100],name:s.name});setError('');}}><svg width="28" height="28" viewBox="0 0 100 100" aria-hidden="true"><path d={s.path} fill="currentColor"/></svg>{s.name}</button>)}</div>
    <svg viewBox={vb.join(' ')} width="100%" height="110" aria-label="矢量轮廓预览"><path d={element.shapePath} fill={element.fill||'none'} stroke={element.borderColor||'currentColor'} strokeWidth="1"/></svg>
    <label className="btn sm">导入 SVG 路径<input type="file" accept=".svg,image/svg+xml" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f)void load(f);e.target.value='';}}/></label>
    <div className="small faint">导入纯路径 SVG，保留 viewBox；多个路径作为统一轮廓使用，颜色由本图层设置。</div>
    {error&&<div role="alert">{error}</div>}
    <details className="mt8"><summary>高级：编辑路径数据</summary><textarea className="input mono" rows={5} aria-label="SVG路径" value={element.shapePath??''} onChange={e=>onPatch({shapePath:e.target.value})}/></details>
  </div>;
}
