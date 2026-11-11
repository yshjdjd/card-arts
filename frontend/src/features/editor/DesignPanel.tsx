import {MATERIALS} from '../../lib/materials';
import React, { useState } from 'react';
import { Modal } from '../../components/ui';
import { designCatalog } from '../../lib/designCommands';
import { designNumber, STYLE_KEYS } from '../../lib/designSystem';
import type { Layout, LayoutElement, ProjectContent } from '../../lib/types';
import { FONTS } from '../../lib/presets';
import { fontKey } from '../../lib/fontIdentity';
import { useAssets } from '../../state/store';

export default function DesignPanel({content,layout,selected,onClose,onCommand,onPatch}:{content:ProjectContent;layout:Layout;selected:string[];onClose:()=>void;onCommand:(operation:string,args:Record<string,unknown>)=>Promise<unknown>;onPatch:(ids:string[],patch:Partial<LayoutElement>)=>Promise<void>}){
  const members=layout.elements.filter(e=>selected.includes(e.id)),first=members[0];
  const styles=content.settings?.designStyles??[],components=content.settings?.designComponents??[];
  const [clipSource,setClipSource]=useState('');
  const [tab,setTab]=useState('styles'),[name,setName]=useState(''),[style,setStyle]=useState(first?.styleId??styles[0]?.id??''),[component,setComponent]=useState(first?.componentId??components[0]?.id??''),[unit,setUnit]=useState<'px'|'mm'>('mm');
  const [size,setSize]=useState(first?.fontSize??32),[color,setColor]=useState(first?.color??'#111827'),[fill,setFill]=useState(first?.fill??'#ffffff'),[font,setFont]=useState(first?.fontFamily??'sans');
  const [horizontal,setHorizontal]=useState('left'),[vertical,setVertical]=useState('top'),[direction,setDirection]=useState('vertical'),[gap,setGap]=useState(12),[padding,setPadding]=useState(first?.padding??0),[paragraph,setParagraph]=useState(first?.paragraphSpacing??0),[indent,setIndent]=useState(first?.firstLineIndent??0),[iconScale,setIconScale]=useState(first?.inlineIconScale??1),[iconOffset,setIconOffset]=useState(first?.inlineIconOffset??0);
  const [grow,setGrow]=useState((first?.height??100)+100),[image,setImage]=useState(''),[mask,setMask]=useState(first?.imageMask??'rectangle'),[path,setPath]=useState(first?.maskPath??''),[gradient,setGradient]=useState(!!first?.gradient),[from,setFrom]=useState(first?.gradient?.from??'#2563eb'),[to,setTo]=useState(first?.gradient?.to??'#9333ea'),[angle,setAngle]=useState(first?.gradient?.angle??90),[shadow,setShadow]=useState(!!first?.shadow),[blur,setBlur]=useState(first?.shadow?.blur??8),[blend,setBlend]=useState(first?.blendMode??'source-over');
  const [guideValue,setGuideValue]=useState(100);
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
  const {assets}=useAssets();
  const run=async(fn:()=>Promise<unknown>)=>{if(working)return;setWorking(true);setError('');try{const r=await fn();setResult(typeof r==='string'?r:typeof (r as any)?.affected==='number'?`已更新 ${(r as any).affected} 个关联项`:'已保存设计设置');}catch(e){setError((e as Error).message);}finally{setWorking(false);}};
  const command=(op:string,args:Record<string,unknown>={})=>void run(()=>onCommand(op,{ids:selected,...args}));
  const button=(label:string,op:string,args:Record<string,unknown>={},enabled=true)=><button className="btn sm" disabled={working||!enabled} onClick={()=>command(op,args)}>{label}</button>;
  const number=(label:string,value:number,set:(v:number)=>void,min=0)=><label className="field small">{label}<input className="input" type="number" min={min} value={value} onChange={e=>set(Number(e.target.value))}/></label>;
  const catalog=designCatalog(content);
  const styleUsage=catalog.styles.find(s=>s.id===style)?.usage,componentUsage=catalog.components.find(c=>c.id===component)?.usage;
  return <Modal wide title="精细设计系统" onClose={()=>{if(!working)onClose();}} footer={<button className="btn" disabled={working} onClick={onClose}>完成</button>}>
    <div className="small faint">所选 {members.length} 层 · 共享样式和组件更新可影响多个牌组；实例局部修改默认保留。</div>
    <div className="row wrap mt8" style={{gap:6}}>{[['styles','共享样式'],['components','组件实例'],['layout','精确排版'],['effects','文字与视觉']].map(([id,label])=><button className={`btn sm ${tab===id?'primary':''}`} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    <div style={{marginTop:12}}><div className="row wrap" style={{gap:8}}>{button("添加自适应技能块","skill.create",{title:name||"技能名称",body:"在此编辑技能描述。"},true)}</div>
      <div className="row wrap mt8" style={{gap:6}}><select className="select" aria-label="裁切轮廓" value={clipSource} onChange={e=>setClipSource(e.target.value)}><option value="">选择裁切轮廓…</option>{layout.elements.filter(e=>['rectangle','ellipse','path'].includes(e.kind)).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select>{button('用轮廓裁切所选图层','clip.create',{source:clipSource},!!clipSource&&!!members.length)}{button('解除所选裁切','clip.release',{},!!members.length)}</div><div className="small faint">裁切源作为轮廓使用，不单独显示。移动轮廓或内容可调整裁切；需要可见边框时复制轮廓作为装饰层。</div>
      <div className="mt8"><div className="small faint">材质预设（替换所选形状的填充、纹理、描边及阴影；位置和路径不变）</div><div className="row wrap" style={{gap:6}}>{MATERIALS.map(m=><button className="btn sm" key={m.id} disabled={working||!members.length} onClick={()=>command('material.apply',{material:m.id})}><span style={{display:'inline-block',width:18,height:18,verticalAlign:'middle',marginRight:4,background:`linear-gradient(110deg,${m.from},${m.to})`,border:`1px solid ${m.border}`}}/>{m.name}</button>)}</div></div>
      {tab==='styles'&&<>
        <label className="lbl">共享样式<select className="select" value={style} onChange={e=>{const id=e.target.value;setStyle(id);const s=styles.find(s=>s.id===id);if(s){setName(s.name);setSize(s.properties.fontSize??32);setColor(s.properties.color??'#111827');setFill(s.properties.fill??'#ffffff');setFont(s.properties.fontFamily??'sans');}}}><option value="">请选择</option>{styles.map(s=><option key={s.id} value={s.id}>{s.name} · v{s.revision}</option>)}</select></label>
        <div className="small faint mt8">影响范围：{styleUsage?.layers??0} 层 / {styleUsage?.decks.length??0} 个牌组，{styleUsage?.localOverrides??0} 层有局部覆盖；锁定层跳过共享样式同步。</div>
        <input className="input mt8" placeholder="样式名称" value={name} onChange={e=>setName(e.target.value)}/>
        <div className="grid2 mt8">{number('字号 px',size,setSize,1)}<label className="field small">字体<select className="select" value={font} onChange={e=>setFont(e.target.value)}>{[...FONTS.map(f=>({key:f.key,name:f.name})),...assets.filter(a=>a.kind==='font').map(a=>({key:fontKey(a.id),name:a.name}))].map(f=><option key={f.key} value={f.key}>{f.name}</option>)}</select></label><label>文字颜色<input className="input" type="color" value={color} onChange={e=>setColor(e.target.value)}/></label><label>填充颜色<input className="input" type="color" value={fill} onChange={e=>setFill(e.target.value)}/></label></div>
        <div className="row wrap mt8" style={{gap:6}}>
          {button('从所选创建样式','style.save',{name,properties:first?{...Object.fromEntries(STYLE_KEYS.filter(k=>first[k]!==undefined).map(k=>[k,first[k]])),fontSize:size,color,fill,fontFamily:font}:{fontSize:size,color,fill,fontFamily:font}},!!name.trim())}
          {button('更新当前样式并同步','style.save',{style,name:name||styles.find(s=>s.id===style)?.name,properties:{fontSize:size,color,fill,fontFamily:font}},!!style)}
          {button('应用到所选','style.apply',{style},!!style&&!!members.length)}{button('重置局部覆盖','style.reset',{style},!!style&&!!members.length)}{button('解除样式关联','style.detach',{},!!members.length)}
        </div><div className="small faint mt8">属性面板中的手动调整会成为局部覆盖。更新共享样式时不会覆盖这些属性；“重置局部覆盖”重新跟随样式。</div>
      </>}
      {tab==='components'&&<>
        <label className="lbl">项目组件<select className="select" value={component} onChange={e=>{setComponent(e.target.value);setName(components.find(c=>c.id===e.target.value)?.name??'');}}><option value="">请选择</option>{components.map(c=><option key={c.id} value={c.id}>{c.name} · {c.elements.length} 层 · v{c.revision}</option>)}</select></label>
        <div className="small faint mt8">影响范围：{componentUsage?.layers??0} 层 / {componentUsage?.decks.length??0} 个牌组，{componentUsage?.localOverrides??0} 层有局部覆盖。</div>
        <input className="input mt8" placeholder="组件名称" value={name} onChange={e=>setName(e.target.value)}/>
        <div className="row wrap mt8" style={{gap:6}}>{button('保存所选为组件','component.save',{name},!!members.length&&!!name.trim())}{button('插入组件实例','component.insert',{component},!!component)}{button('用所选更新主组件并同步','component.save',{component,name:name||components.find(c=>c.id===component)?.name},!!component&&!!members.length)}{button('同步实例（保留覆盖）','component.sync',{component},!!component)}{button('重置所有实例覆盖','component.reset',{component},!!component)}{button('解除所选实例关联','component.detach',{},!!members.length)}</div>
        <div className="small faint mt8">费用徽章、攻防条等可保存为组件。跨牌组插入前需有相同绑定字段。更新不会改变卡牌字段值；重置覆盖作用于该组件的所有实例。</div>
      </>}
      {tab==='layout'&&<>
        <label className="lbl">精确单位<select className="select" value={unit} onChange={e=>setUnit(e.target.value as typeof unit)}><option value="mm">mm</option><option value="px">px</option></select></label>
        {first?<div className="grid2 mt8">{(['x','y','width','height'] as const).map(key=>{const ratio=(key==='x'||key==='width')?layout.width/(layout.widthMm??63.5):layout.height/(layout.heightMm??88.9);const value=unit==='mm'?first[key]/ratio:first[key];return <label key={key} className="field small">{({x:'X',y:'Y',width:'宽',height:'高'})[key]}（{unit}）<input className="input" key={`${first.id}:${key}:${unit}:${value}`} defaultValue={Number(value.toFixed(3))} onBlur={e=>{const raw=e.target.value;if(raw===String(Number(value.toFixed(3))))return;void run(async()=>{const n=designNumber(raw,unit,ratio);if((key==='width'||key==='height')&&n<1)throw new Error('尺寸需大于0');await onPatch([first.id],{[key]:n});});}} placeholder="支持 10+2 或 (20-4)/2"/></label>;})}</div>:<div className="small faint">先在图层面板选择元素。</div>}
        <div className="grid2 mt8"><label>水平锚点<select className="select" value={horizontal} onChange={e=>setHorizontal(e.target.value)}>{['left','right','center','stretch'].map(x=><option key={x}>{x}</option>)}</select></label><label>垂直锚点<select className="select" value={vertical} onChange={e=>setVertical(e.target.value)}>{['top','bottom','center','stretch'].map(x=><option key={x}>{x}</option>)}</select></label></div>
        {button('设定所选锚点','layout.anchor',{horizontal,vertical},!!members.length)}
        <div className="grid2 mt8"><label>自动布局方向<select className="select" value={direction} onChange={e=>setDirection(e.target.value)}><option value="vertical">纵向</option><option value="horizontal">横向</option></select></label>{number('间距 px',gap,setGap)}{number('内边距 px',padding,setPadding)}</div>
        {button('所选建立自动布局','layout.flow',{direction,gap,padding},!!members.length)}
        <div className="grid2 mt8">{number('规则区最大高度 px',grow,setGrow,1)}<label>优先压缩的插图<select className="select" value={image} onChange={e=>setImage(e.target.value)}><option value="">向下扩展</option>{layout.elements.filter(e=>e.kind==='image').map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label></div>
        {button('允许所选文字按内容扩展','layout.grow',{maxHeight:grow,image},!!members.length)}{button('解除所选约束 / 自动布局','layout.clear',{},!!members.length)}
        <div className="grid2 mt8">{number('参考线位置 px',guideValue,setGuideValue)}</div>{button('添加纵参考线','layout.guide',{axis:'x',value:guideValue})}{button('添加横参考线','layout.guide',{axis:'y',value:guideValue})}{button('清除参考线','layout.guide',{clear:true})}
        <div className="small faint mt8">自动布局控制成员位置；需解除后手动拖动。文字扩展优先使用当前字号，再由最小字号限制处理溢出。横纵参考线和网格在编辑器工具栏开启。</div>
      </>}
      {tab==='effects'&&<>
        <div className="grid2">{number('文本内边距 px',padding,setPadding)}{number('段后距 px',paragraph,setParagraph)}{number('首行缩进 px',indent,setIndent)}{number('行内图标倍率',iconScale,setIconScale,.1)}{number('行内图标下移 px',iconOffset,setIconOffset,-100)}</div>
        <div className="grid2 mt8"><label>图片蒙版<select className="select" value={mask} onChange={e=>setMask(e.target.value as typeof mask)}><option value="rectangle">矩形 / 圆角</option><option value="ellipse">椭圆</option></select></label><label>纹理 / 图层混合<select className="select" value={blend} onChange={e=>setBlend(e.target.value as typeof blend)}>{['source-over','multiply','screen','overlay'].map(x=><option key={x}>{x}</option>)}</select></label></div>
        <label className="small">自定义图片裁切路径（可选，SVG path，坐标 0–100）<input className="input" value={path} onChange={e=>setPath(e.target.value)} placeholder="M 50 0 L 100 100 L 0 100 Z"/></label>
        <label className="small"><input type="checkbox" checked={gradient} onChange={e=>setGradient(e.target.checked)}/> 文字 / 形状渐变</label>
        {gradient&&<div className="grid2"><input type="color" value={from} onChange={e=>setFrom(e.target.value)}/><input type="color" value={to} onChange={e=>setTo(e.target.value)}/>{number('渐变角度',angle,setAngle,-360)}</div>}
        <label className="small"><input type="checkbox" checked={shadow} onChange={e=>setShadow(e.target.checked)}/> 阴影</label>{shadow&&number('阴影模糊 px',blur,setBlur)}
        <button className="btn primary mt8" disabled={working||!members.length} onClick={()=>void run(()=>onPatch(selected,{padding,paragraphSpacing:paragraph,firstLineIndent:indent,inlineIconScale:iconScale,inlineIconOffset:iconOffset,imageMask:mask,maskPath:path||undefined,gradient:gradient?{from,to,angle}:undefined,shadow:shadow?{color:'#00000066',blur,x:3,y:4}:undefined,blendMode:blend}))}>应用精细效果到所选</button>
        <div className="small faint mt8">纹理可作为普通图片层叠放，通过透明度和混合模式控制。自定义路径是裁切区域，不会修改原素材。</div>
      </>}
    </div>
    {working&&<div role="status">处理中…</div>}{error&&<div role="alert" className="small mt8">{error}</div>}{result&&<div className="small faint mt8" style={{maxHeight:70,overflow:'auto',overflowWrap:'anywhere'}}>操作完成：{result}</div>}
  </Modal>;
}
