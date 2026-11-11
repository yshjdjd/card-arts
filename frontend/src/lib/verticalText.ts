import {parseTextRuns} from './textLayout';
import {fontCss} from './presets';
import type {LayoutElement} from './types';

/** 直立字形的分栏竖排；换行强制换列，保留富文本与行内图标。 */
export function layoutVertical(raw:string,e:LayoutElement,scale=1){
 const make=(size:number)=>{
  const padding=(e.padding??0)*scale,w=Math.max(1,e.width*scale-padding*2),h=Math.max(1,e.height*scale-padding*2);
  const columns:Array<Array<{text:string;kind:string;key?:string;size:number;font:string;color?:string;y:number}>>=[[]];
  let y=0;
  for(const run of parseTextRuns(raw.replace(/\r\n?/g,'\n'),!!e.richText,e.fontSize??24)){
   const fontSize=size*run.factor,font=`${run.italic||e.fontStyle==='italic'?'italic':'normal'} ${run.bold||e.fontWeight==='bold'?'bold':'normal'} ${fontSize}px ${fontCss(e.fontFamily)}`;
   for(const ch of run.kind==='text'?[...run.text]:['']){
    if(ch==='\n'){columns.push([]);y=0;continue;}
    if(y>0&&y+fontSize>h){columns.push([]);y=0;}
    columns.at(-1)!.push({text:ch,kind:run.kind,key:run.key,size:fontSize,font,color:run.color,y});
    y+=Math.max(1,fontSize+(e.letterSpacing??0)*scale);
   }
  }
  const widths=columns.map(c=>Math.max(size,...c.map(g=>g.size))*(e.lineHeight??1.25));
  const total=widths.reduce((a,b)=>a+b,0);let cursor=0;
  const glyphs=columns.flatMap((col,i)=>{const ch=col.length?col.at(-1)!.y+col.at(-1)!.size:0;
   const top=e.verticalAlign==='middle'?(h-ch)/2:e.verticalAlign==='bottom'?h-ch:0;
   const left=e.writingMode==='vertical-lr'?cursor:w-cursor-widths[i];cursor+=widths[i];
   return col.map(g=>({...g,x:padding+left+(widths[i]-g.size)/2,y:padding+g.y+top}));});
  return {glyphs,overflow:total>w||glyphs.some(g=>g.y+g.size>h+padding),size};
 };
 let size=(e.autoFit?(e.maxFontSize??e.fontSize??24):(e.fontSize??24))*scale,result=make(size);
 const min=Math.max(1,(e.minFontSize??8)*scale);
 if(e.autoFit)while(result.overflow&&size>min){size=Math.max(min,size-scale);result=make(size);}
 return result;
}
