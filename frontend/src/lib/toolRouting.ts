import {buildToolDefinitions,type ToolDefinition} from './agentProtocol';

/** 客户端工具发现，兼容普通 function calling，不依赖厂商专用 tool_search。 */
export function createToolRouter(text:string,extra:ToolDefinition[]=[],web=true){
 const all=buildToolDefinitions(extra,web),active=new Set(['project_overview','tools_discover','todo_write','conversation_readResult']);
 const groups:Array<[RegExp,string[]]>=[
  [/卡牌|牌组|字段|武将|card|deck/i,['deck_list','field_list','card_list']],
  [/版式|图层|形状|组件|字体|设计|layout|design/i,['element_list','layer_list','design_catalog']],
  [/文档|表格|document/i,['doc_list','doc_read']],
  [/搜索|联网|调研|research|search/i,['web_research','web_search']],
  [/天气|weather/i,['web_search','web_fetch']],
  [/历史|之前|继续|history|continue/i,['conversation_search','conversation_readTurn']],
 ];
 for(const [pattern,names] of groups)if(pattern.test(text))names.forEach(n=>active.add(n));
 const definitions=()=>all.filter(d=>active.has(d.function.name));
 const discover=async(args:Record<string,unknown>)=>{
  const names=Array.isArray(args.names)?args.names.filter((x):x is string=>typeof x==='string').map(n=>n.replace(/\./g,'_')):[];
  const terms=String(args.query??'').toLowerCase().split(/[\s,，/]+/).filter(Boolean);
  if(!names.length&&!terms.length)return '可检索分类：project/deck/field/card/element/layout/layer/design/template/doc/asset/font/web/conversation/files；用 query 分类或 names 精确工具名加载。';
  const matches=all.map(d=>({d,score:names.includes(d.function.name)?100:terms.reduce((n,t)=>n+(d.function.name.toLowerCase().includes(t.replace(/\./g,'_'))?5:d.function.description.toLowerCase().includes(t)?1:0),0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>x.d);
  matches.forEach(d=>active.add(d.function.name));
  return matches.length?JSON.stringify({loaded:matches.map(d=>({name:d.function.name,description:d.function.description.slice(0,350)})),message:'上述工具已加载，将在下一次模型请求提供完整参数；更多工具请继续检索。'}):'没有匹配工具；可用英文分类或精确工具名再次检索。联网关闭时不会提供 web 工具。';
 };
 return {definitions,discover,total:all.length};
}
