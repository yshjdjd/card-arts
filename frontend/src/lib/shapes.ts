import type { LayoutElement } from './types';

export const SHAPES = [
  {id:'shield',name:'盾牌',path:'M10 5 L90 5 L90 48 Q90 78 50 98 Q10 78 10 48 Z'},
  {id:'banner',name:'旗帜',path:'M5 5 L95 5 L95 95 L50 75 L5 95 Z'},
  {id:'ribbon',name:'缎带',path:'M0 10 L100 10 L85 50 L100 90 L0 90 L15 50 Z'},
  {id:'rectangle',name:'矩形'}, {id:'rounded',name:'圆角矩形'},
  {id:'ellipse',name:'椭圆'}, {id:'circle',name:'圆形'}, {id:'line',name:'线条'},
  {id:'triangle',name:'三角形',path:'M50 0 L100 100 L0 100 Z'},
  {id:'diamond',name:'菱形',path:'M50 0 L100 50 L50 100 L0 50 Z'},
  {id:'pentagon',name:'五边形',path:'M50 0 L98 35 L80 100 L20 100 L2 35 Z'},
  {id:'hexagon',name:'六边形',path:'M25 0 L75 0 L100 50 L75 100 L25 100 L0 50 Z'},
  {id:'star',name:'五角星',path:'M50 0 L62 35 L100 38 L71 61 L80 100 L50 78 L20 100 L29 61 L0 38 L38 35 Z'},
  {id:'arrow',name:'箭头',path:'M0 30 L60 30 L60 0 L100 50 L60 100 L60 70 L0 70 Z'},
  {id:'trapezoid',name:'梯形',path:'M25 0 L75 0 L100 100 L0 100 Z'},
] as const;

export function shapeProperties(id:string): Partial<LayoutElement> {
  const shape=SHAPES.find(s=>s.id===id);
  if(!shape)throw new Error(`未知形状：${id}`);
  return {kind:id==='ellipse'||id==='circle'?'ellipse':id==='line'?'line':'rectangle',name:shape.name,
    shapePath:'path' in shape?shape.path:undefined,borderRadius:id==='rounded'?20:0,
    ...(id==='circle'?{width:160,height:160}:{}),
    ...(id==='line'?{height:4,fill:'#111827',borderWidth:2}:{})};
}
