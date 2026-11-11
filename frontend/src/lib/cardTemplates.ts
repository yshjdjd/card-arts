import {remapContainerRefs} from './designSystem';
import type { Deck, Field, Layout, LayoutElement, ProjectContent } from './types';
import { CARD_PRESETS } from './presets';

export interface CardTemplate {id:string;name:string;category:string;description:string;tags:string[];fields:Field[];pattern:string;front?:Layout|null;back?:Layout|null;custom?:boolean}
export const TEMPLATE_THEMES={parchment:{name:'羊皮纸',bg:'#f6f0e3',panel:'#fffaf0',ink:'#302a24',accent:'#825a37'},midnight:{name:'深空',bg:'#172333',panel:'#24364c',ink:'#f1f5f9',accent:'#61c7df'},minimal:{name:'简洁',bg:'#ffffff',panel:'#f1f5f9',ink:'#18212f',accent:'#3b6b50'}};
const field=(id:string,name:string,type:Field['type']='text',defaultValue:unknown=''):Field=>({id,name,type,defaultValue,showInTable:true});
const base=[field('name','名称'),field('art','插图','image'),field('type','类型'),field('description','描述'),field('serial','编号')];
const specs=[
  ['unit','角色 / 单位','战斗','上部插图，下部规则，底部攻防数值',['cost','attack','health']],
  ['spell','法术 / 行动','战斗','大幅插图与醒目效果区，费用位于标题右侧',['cost']],
  ['equipment','装备 / 道具','战斗','插图、使用条件与效果，底部耐久数值',['cost','durability']],
  ['event','事件 / 遭遇','叙事','横向标题、环境插图、触发条件与结算效果',['trigger']],
  ['resource','资源 / 能量','经济','中央大数值，底部资源说明',['amount']],
  ['quest','任务 / 目标','叙事','插图、目标条件、完成奖励三区分层',['objective','reward']],
  ['location','地点 / 建筑','地图','全幅插图，上下信息面板与地点效果',['cost']],
  ['reference','规则 / 参考','工具','文本优先的大容量说明区域',['steps']],
  ['poker','数字 / 花色','传统','对角点数与中央花色，适合数字牌',['rank','suit']],
  ['tarot','叙事 / 塔罗','叙事','纵长插图，顶部序号与底部叙事文字',['chapter']],
] as const;
const numeric=new Set(['cost','attack','health','durability','amount']);
const labels:Record<string,string>={cost:'费用',attack:'攻击',health:'生命',durability:'耐久',trigger:'触发条件',amount:'数量值',objective:'目标条件',reward:'奖励',steps:'步骤说明',rank:'点数',suit:'花色',chapter:'章节'};
export const CARD_TEMPLATES:CardTemplate[]=specs.map(([id,name,category,description,extra])=>({id,name,category,description,pattern:id,tags:[category,id],fields:[...base,...extra.map(key=>field(key,labels[key],numeric.has(key)?'number':'text',numeric.has(key)?0:''))]}));
export function allCardTemplates(content:ProjectContent):CardTemplate[]{
  const custom=content.settings?.cardTemplates;
  return [...CARD_TEMPLATES,...(Array.isArray(custom)?custom.filter(t=>t&&t.custom&&typeof t.id==='string'&&Array.isArray(t.fields)&&t.front):[])];
}
export interface TemplateOptions {theme?:string;preset?:string;font?:string;mapping?:Record<string,string>;side?:'front'|'back'|'both';sample?:boolean}
const aliases:Record<string,string[]>={description:['规则','效果','说明'],art:['图片','立绘','image'],health:['生命值','防御'],cost:['消耗'],attack:['攻击力']};
export function templateFields(template:CardTemplate,existing:Field[],mapping:Record<string,string>={},id:()=>string){
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.entries(mapping).some(([key,value])=>!template.fields.some(f=>f.id===key)||typeof value!=='string'))throw new Error('mapping 必须是模板字段 ID 到已有字段 ID 的映射');
  const fields=structuredClone(existing),bindings:Record<string,string>={},added:Field[]=[];
  for(const role of template.fields){
    const compatible=(f:Field)=>f.type===role.type||(role.type==='text'&&f.type==='select');
    let match:Field|undefined;
    if(mapping[role.id]){match=fields.find(f=>f.id===mapping[role.id]);if(!match||!compatible(match))throw new Error(`字段映射无效或类型不兼容：${role.name}`);}
    else {
      match=fields.find(f=>f.id===role.id&&compatible(f));
      if(!match){const candidates=fields.filter(f=>compatible(f)&&[role.name,...aliases[role.id]??[]].includes(f.name));if(candidates.length>1)throw new Error(`字段「${role.name}」有多个匹配，请指定 mapping`);match=candidates[0];}
    }
    if(!match){match={...structuredClone(role),id:fields.some(f=>f.id===role.id)?id():role.id};fields.push(match);added.push(match);}
    bindings[role.id]=match.id;
  }
  return {fields,bindings,added};
}

function buildLayout(template:CardTemplate,bindings:Record<string,string>,options:TemplateOptions,id:()=>string,existing?:Layout|null,back=false):Layout{
  const preset=options.preset?CARD_PRESETS.find(p=>p.key===options.preset):undefined;
  if(options.preset&&!preset)throw new Error('未知卡牌尺寸预设');
  const theme=TEMPLATE_THEMES[(options.theme??'parchment') as keyof typeof TEMPLATE_THEMES];if(!theme)throw new Error('未知配色');
  const source=back?template.back:template.front;
  const w=preset?.width??existing?.width??source?.width??(template.pattern==='tarot'?825:750),h=preset?.height??existing?.height??source?.height??(template.pattern==='tarot'?1425:1050);
  const layout:Layout={id:id(),name:back?'模板牌背':template.name,width:w,height:h,widthMm:preset?.widthMm??existing?.widthMm??source?.widthMm??(template.pattern==='tarot'?69.9:63.5),heightMm:preset?.heightMm??existing?.heightMm??source?.heightMm??(template.pattern==='tarot'?120.7:88.9),backgroundColor:theme.bg,borderColor:theme.accent,borderWidth:0,borderRadius:24,elements:[]};
  if(template.custom&&source){
    const sx=w/source.width,sy=h/source.height,groups=new Map<string,string>(),elementIds=new Map(source.elements.map(el=>[el.id,id()]));
    return {...structuredClone(source),...layout,backgroundColor:source.backgroundColor,borderColor:source.borderColor,borderWidth:source.borderWidth,borderRadius:source.borderRadius*Math.min(sx,sy),flows:source.flows?.map(f=>({...structuredClone(f),id:id(),ids:f.ids.map(old=>elementIds.get(old)!).filter(Boolean),x:f.x*sx,y:f.y*sy,width:f.width*sx,gap:f.gap*Math.min(sx,sy),padding:f.padding*Math.min(sx,sy)})),guides:source.guides?.map(g=>({...g,value:g.value*(g.axis==='x'?sx:sy)})),elements:source.elements.map(el=>{
      if(el.groupId&&!groups.has(el.groupId))groups.set(el.groupId,id());
      const value={...structuredClone(el),id:elementIds.get(el.id)!,groupId:el.groupId?groups.get(el.groupId):undefined,instanceId:el.instanceId?(groups.get(el.groupId??el.instanceId)??id()):undefined,x:el.x*sx,y:el.y*sy,width:el.width*sx,height:el.height*sy};
      remapContainerRefs(value,elementIds);
      if(value.fitContent)value.fitContent.padding*=Math.min(sx,sy);
      if(value.stackAfter)value.stackAfter.gap*=sy;
      if(el.countSlotsFieldId)value.countSlotsFieldId=bindings[el.countSlotsFieldId]??el.countSlotsFieldId;
      if(el.fieldId)value.fieldId=bindings[el.fieldId]??el.fieldId;
      if(el.countFieldId)value.countFieldId=bindings[el.countFieldId]??el.countFieldId;
      for(const [key,raw] of Object.entries(value))if(typeof raw==='string')(value as any)[key]=raw.replace(/\{([^{}]+)\}/g,(token,field)=>bindings[field]?`{${bindings[field]}}`:token);
      const remapCondition=(c:any):any=>c?.conditions?{...c,conditions:c.conditions.map(remapCondition)}:c?{...c,fieldId:bindings[c.fieldId]??c.fieldId}:c;
      value.displayCondition=remapCondition(value.displayCondition);
      if(value.textGrowth){value.textGrowth.maxHeight*=sy;if(value.textGrowth.shrinkImageId)value.textGrowth.shrinkImageId=elementIds.get(value.textGrowth.shrinkImageId);}
      if(value.anchors){const a=value.anchors;a.referenceWidth*=sx;a.referenceHeight*=sy;a.left*=sx;a.right*=sx;a.top*=sy;a.bottom*=sy;a.centerX*=sx;a.centerY*=sy;}
      for(const key of ['fontSize','minFontSize','maxFontSize','borderWidth','borderRadius','letterSpacing'] as const)if(typeof value[key]==='number')(value as any)[key]*=Math.min(sx,sy);
      if(options.font&&value.kind==='text')value.fontFamily=options.font;
      return value;
    })};
  }
  const groupIds=new Map<string,string>();
  const element=(name:string,kind:LayoutElement['kind'],x:number,y:number,width:number,height:number,extra:Partial<LayoutElement>={},group='frame')=>{
    if(!groupIds.has(group))groupIds.set(group,id());
    const scale=Math.min(w/750,h/1050);
    const el:LayoutElement={id:id(),name,kind,x:x*w,y:y*h,width:width*w,height:height*h,rotation:0,fill:theme.panel,color:theme.ink,borderWidth:0,groupId:groupIds.get(group),...extra};
    if(kind==='text'){Object.assign(el,{fontFamily:options.font??'sans',fontSize:Math.round((extra.fontSize??30)*scale),minFontSize:Math.max(12,Math.round(Math.min(extra.fontSize??30,22)*scale)),autoFit:true,wrapMode:'anywhere',verticalAlign:extra.verticalAlign??'middle',horizontalAlign:extra.horizontalAlign??'left',lineHeight:1.25});}
    layout.elements.push(el);
  };
  const text=(role:string,name:string,x:number,y:number,width:number,height:number,size=30,extra:Partial<LayoutElement>={})=>element(name,'text',x,y,width,height,{fieldId:bindings[role],fontSize:size,...extra},name);
  const panel=(name:string,x:number,y:number,width:number,height:number)=>element(name,'rectangle',x,y,width,height,{borderRadius:16});
  const art=(y:number,height:number)=>{element('插图底板','rectangle',.065,y,.87,height,{fill:theme.accent,fillOpacity:.2});element('插图','image',.065,y,.87,height,{fieldId:bindings.art,imageFit:'cover'},'art');};
  if(back){
    element('牌背装饰','ellipse',.25,.31,.5,.36,{fill:theme.accent});
    element('牌背标识','text',.15,.4,.7,.13,{text:'CARD ARTS',fontSize:48,color:theme.bg,horizontalAlign:'center'});
    element('牌背说明','text',.15,.76,.7,.05,{text:template.name,fontSize:22,horizontalAlign:'center'});return layout;
  }
  if(template.pattern==='location'){art(.05,.9);panel('标题底板',.065,.07,.87,.12);panel('规则底板',.065,.65,.87,.27);}
  else panel('顶部标题区',.055,.045,.89,.12);
  text('name','卡牌名称',.085,.06,.67,.065,40,{fontWeight:'bold'});
  if(bindings.cost){element('费用底板','ellipse',.78,.055,.13,.09,{fill:theme.accent},'cost');text('cost','费用',.80,.065,.09,.06,38,{color:theme.bg,horizontalAlign:'center'});}
  if(template.pattern==='resource'){
    element('资源徽章','ellipse',.21,.25,.58,.42,{fill:theme.accent});text('amount','资源数值',.26,.34,.48,.20,110,{color:theme.bg,horizontalAlign:'center'});panel('资源说明区',.065,.72,.87,.20);text('description','资源说明',.10,.75,.80,.14);
  }else if(template.pattern==='poker'){
    text('rank','左上点数',.09,.18,.22,.12,70);text('suit','中央花色',.25,.36,.5,.25,110,{horizontalAlign:'center'});text('rank','右下点数',.68,.73,.22,.12,70,{rotation:180});
  }else if(template.pattern==='reference'){
    text('type','参考类型',.09,.17,.82,.05,24);panel('参考说明区',.065,.245,.87,.67);text('steps','步骤说明',.10,.27,.80,.43,29,{verticalAlign:'top'});text('description','补充说明',.10,.74,.80,.13,24,{verticalAlign:'top'});
  }else{
    const tall=template.pattern==='tarot',quest=template.pattern==='quest';
    if(template.pattern!=='location')art(.19,tall?.55:quest?.32:.39);
    const y=tall?.77:quest?.55:.62;
    text('type','类型栏',.09,tall?.165:.145,.70,.035,22);
    if(template.pattern!=='location')panel('规则说明区',.065,y,.87,tall?.18:.30);
    if(quest){text('objective','目标条件',.10,.57,.80,.13,30,{verticalAlign:'top'});text('reward','完成奖励',.10,.73,.80,.12,28,{verticalAlign:'top'});}
    else if(template.pattern==='event'){text('trigger','触发条件',.10,y+.02,.80,.06,26);text('description','事件效果',.10,y+.10,.80,.16,29,{verticalAlign:'top'});}
    else text('description','规则说明',.10,y+.025,.80,tall?.17:.22,30,{verticalAlign:'top'});
    if(template.pattern==='unit'){text('attack','攻击',.10,.91,.34,.04,30);text('health','生命',.56,.91,.34,.04,30,{horizontalAlign:'right'});}
    if(template.pattern==='equipment')text('durability','耐久',.65,.91,.25,.04,30,{horizontalAlign:'right'});
    if(tall)text('chapter','章节',.68,.145,.22,.035,22,{horizontalAlign:'right'});
  }
  text('serial','卡牌编号',.10,.955,.80,.022,16,{horizontalAlign:'center'});
  return layout;
}

export function instantiateTemplate(template:CardTemplate,deck:Deck,options:TemplateOptions,id:()=>string){
  const {fields,bindings,added}=templateFields(template,deck.fields,options.mapping,id);
  const next=structuredClone(deck);next.fields=fields;
  const side=options.side??'both';if(!['front','back','both'].includes(side))throw new Error('side 必须为 front/back/both');
  if(side!=='back')next.frontLayout=buildLayout(template,bindings,options,id,deck.frontLayout,false);
  if(side!=='front')next.backLayout=buildLayout(template,bindings,options,id,deck.backLayout,true);
  for(const card of next.cards)for(const f of added)if(!(f.id in card.values))card.values[f.id]=f.defaultValue??'';
  return {deck:next,added:added.map(f=>({id:f.id,name:f.name,type:f.type})),bindings};
}
export function captureTemplate(content:ProjectContent,deck:Deck,name:string,id:()=>string):CardTemplate{
  if(!name.trim()||!deck.frontLayout)throw new Error('需提供模板名称且牌组正面版式存在');
  return {id:'custom:'+id(),name:name.trim().slice(0,80),category:'项目模板',description:'从当前牌组保存；素材引用依赖本项目',tags:['custom'],fields:structuredClone(deck.fields),pattern:'custom',custom:true,front:structuredClone(deck.frontLayout),back:structuredClone(deck.backLayout)};
}
