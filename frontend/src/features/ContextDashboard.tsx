import {createToolRouter} from '../lib/toolRouting';
import { resolveCapacity, autoCompactThreshold } from '../lib/modelCapacity';
import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { hydrateAgentItems } from '../db/agentEvents';
import { compactSession } from '../lib/agentCompaction';
import { systemBreakdown } from '../lib/contextMetrics';
import { contextTokens, selectContext, type AgentMessage } from '../lib/agentContext';
import { restoreHistory } from '../lib/agentHistory';
import { buildToolDefinitions } from '../lib/agentProtocol';
import { chatStream, resolveOutputBudget, resolveLLMConfig } from '../lib/llm';
import { fetchRemoteTools } from '../lib/mcp';
import type { ChatSession, LLMConfig } from '../lib/types';

type Snapshot = {messages:AgentMessage[];tools:unknown[];model:string;createdAt:string;window:number;outputTokens:number;
  taskUsage?:{requests:number;reported:number;prompt_tokens:number;completion_tokens:number;total_tokens:number};
  usage?:{prompt_tokens?:number;completion_tokens?:number;total_tokens?:number}};

export function ContextDashboard({chat,cfg,busy,input,buildPrompt}:{chat:ChatSession|null|undefined;cfg:LLMConfig|null|undefined;busy:boolean;input:string;buildPrompt:()=>Promise<string>}) {
  const last = useLiveQuery(async()=>chat ? (await db.settings.get(`agent-context:${chat.id}`))?.value as Snapshot|undefined : undefined,[chat?.id]);
  const [preview,setPreview]=useState<Snapshot>();
  const [removed,setRemoved]=useState(0);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const [working,setWorking]=useState(false);
  const ctrl=useRef<AbortController|null>(null);
  const [source,setSource]=useState<'last'|'preview'>('last');
  useEffect(()=>{setPreview(undefined);setError('');setStatus('');return()=>ctrl.current?.abort();},[chat?.id]);
  const model=cfg ? resolveLLMConfig(cfg,chat?.modelOverride||cfg.model).model : '';
  const snapshot=source==='last'?last:preview;
  const count=(ms:AgentMessage[])=>ms.reduce((n,m)=>n+contextTokens(m.content)+(m.tool_calls?contextTokens(JSON.stringify(m.tool_calls)):0)+12,0);
  const system=count(snapshot?.messages.filter(m=>m.role==='system')??[]);
  const history=count(snapshot?.messages.filter(m=>m.role!=='system')??[]);
  const tools=snapshot?contextTokens(JSON.stringify(snapshot.tools)):0;
  const total=system+history+tools;
  const currentCapacity=cfg?resolveCapacity(cfg,model).tokens:65536;
  const windowSize=snapshot?.window??currentCapacity;
  const output=snapshot?.outputTokens??(cfg?resolveOutputBudget(cfg,model).value:4096);
  const percent=Math.min(100,Math.round((total+output+1024)/windowSize*100));
  const operation=async(fn:(signal:AbortSignal)=>Promise<void>)=>{
    if(working||busy)return;
    const c=new AbortController();ctrl.current=c;setWorking(true);setError('');setStatus('');
    try{await fn(c.signal);}catch(e){setStatus('');setError((e as Error).name==='AbortError'?'已取消，原历史保留':(e as Error).message);}finally{setWorking(false);ctrl.current=null;}
  };
  const inspect=()=>operation(async(signal)=>{
    if(!chat||!cfg)throw new Error('请先选择会话并配置模型');
    const current=await hydrateAgentItems((await db.chats.get(chat.id))!);
    const index=current.summary?current.messages.findIndex(m=>m.id===current.summary!.throughMessageId):-1;
    const remote=await fetchRemoteTools(signal);
    const definitions=createToolRouter(input,remote.defs,current.context?.web!==false).definitions();
    const outputTokens=resolveOutputBudget(cfg,model).value;
    const result=selectContext(await buildPrompt(),restoreHistory(current.messages.slice(index+1)),input.trim()?[{role:'user',content:input.trim()}]:[],resolveCapacity(cfg,model).tokens,outputTokens+contextTokens(JSON.stringify(definitions)));
    if(signal.aborted)return;
    setPreview({messages:result.messages,tools:definitions,model,createdAt:new Date().toISOString(),window:resolveCapacity(cfg,model).tokens,outputTokens});
    setRemoved(result.dropped);setSource('preview');setStatus('预览已更新；不会调用模型或执行工具。');
  });
  const compact=()=>operation(async(signal)=>{
    if(!chat||!cfg?.enabled)throw new Error('请先启用模型');
    const current=await db.chats.get(chat.id);if(!current)throw new Error('会话已删除');
    setStatus('正在压缩历史…');
    const summary=await compactSession(current,resolveCapacity(cfg,model).tokens,model,async(messages)=>{
      let text='',reason='';
      await chatStream({cfg,maxTokens:1800,model,messages,signal,onDelta:d=>{text+=d;},onFinish:r=>{reason=r;}});
      return {text,reason};
    });
    if(signal.aborted)throw new DOMException('aborted','AbortError');
    await db.transaction('rw',db.chats,async()=>{
      const latest=await db.chats.get(chat.id);
      if(!latest||latest.updatedAt!==current.updatedAt)throw new Error('会话已变化，未覆盖摘要；请重试');
      await db.chats.update(chat.id,{summary});
    });
    setPreview(undefined);setStatus('压缩完成，原始消息保留；更新预览可查看新上下文。');
  });
  return <section style={{padding:16,borderBottom:'1px solid var(--border)'}}>
    <b>模型上下文管理</b>
    <div className="small faint">模型：{snapshot?.model||model||'未配置'} · 容量 {windowSize.toLocaleString()} tokens（{source==='last'&&snapshot?'上次请求容量':cfg?resolveCapacity(cfg,model).source:'未配置'}）</div>
    <progress aria-label="上下文预算占用" max={100} value={snapshot?percent:0} style={{width:'100%',marginTop:8}} />
    <div className="small">{snapshot?`预算占用约 ${percent}%`:'尚无请求快照'} · 输出预留 {output.toLocaleString()} · 安全余量 1,024</div>
    <div className="row mt8" style={{gap:6,flexWrap:'wrap'}}>
      <button className="btn sm" disabled={!last} onClick={()=>setSource('last')}>上次实际请求</button>
      <button className="btn sm" disabled={busy||working} onClick={()=>void inspect()}>更新下次请求预览</button>
      <button className="btn sm primary" disabled={busy||working||!cfg?.enabled} onClick={()=>void compact()}>立即压缩历史</button>
      {working&&<button className="btn sm" onClick={()=>ctrl.current?.abort()}>取消</button>}
    </div>
    {status&&<div role="status" className="small mt8">{status}</div>}
    {error&&<div role="alert" className="small mt8">{error}</div>}
    <div className="small faint mt8">{source==='last'?'上次请求快照':'下次请求预览（编辑后需更新）'} {snapshot?.createdAt}</div>
    {snapshot&&<>
      <table className="small" style={{width:'100%'}}><tbody>
        {Object.entries(systemBreakdown(snapshot.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'))).map(([label,value])=><tr key={label}><td>{label}</td><td>约 {value}</td></tr>)}
        <tr><td>系统消息合计（含消息开销）</td><td>约 {system}</td></tr>
        <tr><td>工具定义（{snapshot.tools.length}）</td><td>约 {tools}</td></tr>
        <tr><td>历史、工具结果与当前输入</td><td>约 {history}</td></tr>
        <tr><td>输入合计</td><td>约 {total}</td></tr>
      </tbody></table>
      <div className="small faint">{source==='preview'?`预算移出 ${removed} 条历史；原文仍可查询。`:'仅显示最近一次模型请求，不含摘要请求。'} 所有估算均非计费数据。</div>
      <div className="small">服务商真实用量：{snapshot.usage?`输入 ${snapshot.usage.prompt_tokens??'未返回'} / 输出 ${snapshot.usage.completion_tokens??'未返回'} / 合计 ${snapshot.usage.total_tokens??'未返回'}`:'服务商未返回'}</div>
      {snapshot.taskUsage&&<div className="small">本次任务累计（已完成模型请求，不含摘要请求）：{snapshot.taskUsage.requests} 次请求，{snapshot.taskUsage.reported} 次返回用量；已报告输入 {snapshot.taskUsage.prompt_tokens.toLocaleString()} / 输出 {snapshot.taskUsage.completion_tokens.toLocaleString()} / 合计 {snapshot.taskUsage.total_tokens.toLocaleString()}。未报告部分不计入，不代表用量为零。</div>}
      <details className="small mt8"><summary>查看请求消息与工具定义</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:300,overflow:'auto'}}>{JSON.stringify({messages:snapshot.messages,tools:snapshot.tools},null,2)}</pre></details>
    </>}
    <div className="small mt8">
      <label><input type="checkbox" checked={chat?.autoCompact!==false} disabled={busy||working} onChange={e=>{if(chat)void db.chats.update(chat.id,{autoCompact:e.target.checked});}} /> 自动压缩历史</label>
      <label style={{display:'block'}}>触发阈值（历史估算 tokens）<input type="number" className="input" min={1000} max={currentCapacity} key={`${chat?.id}:${chat?.compactThreshold}`} defaultValue={chat?.compactThreshold||autoCompactThreshold(currentCapacity)} disabled={busy||working} onBlur={e=>{const n=Number(e.target.value);if(chat&&Number.isFinite(n))void db.chats.update(chat.id,{compactThreshold:Math.max(1000,Math.min(currentCapacity,Math.floor(n)))});}} /></label>
      <button className="btn ghost sm" disabled={busy||working} onClick={()=>{if(chat)void db.chats.update(chat.id,{compactThreshold:undefined});}}>按当前模型自动设置阈值</button>
      保留最近完整轮次；短历史可能无需压缩。手动压缩会额外调用一次当前模型。
    </div>
    <details className="small mt8"><summary>任务记忆与压缩记录</summary>
      <label>固定约束<textarea className="input" key={`${chat?.id}:${chat?.pinnedMemory??''}`} defaultValue={chat?.pinnedMemory??''} disabled={busy||working} onBlur={e=>{if(chat)void db.chats.update(chat.id,{pinnedMemory:e.target.value.slice(0,4000)});}} /></label>
      <div style={{whiteSpace:'pre-wrap'}}>{chat?.summary?`最近压缩：${chat.summary.createdAt}\n覆盖截至消息：${chat.summary.throughMessageId}\n${chat.summary.text}`:'尚未压缩历史'}</div>
      <button className="btn sm" disabled={busy||working||!chat?.summary} onClick={()=>{if(chat)void db.chats.update(chat.id,{summary:undefined});setPreview(undefined);}}>恢复使用原历史</button>
      <details><summary>原始历史索引（{chat?.messages.length??0} 条）</summary>{chat?.messages.map(m=><div key={m.id}>{m.id} · {m.role} · {m.content.slice(0,100)}</div>)}</details>
    </details>
  </section>;
}
