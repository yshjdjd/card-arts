import type { LLMConfig } from './types';

export type ModelLimits = {context_window?:number;max_output_tokens?:number};
export function modelScope(baseUrl:string):string {return baseUrl.trim().replace(/\/+$/,'').toLowerCase();}
export function resolveCapacity(cfg:LLMConfig, model=cfg.model):{tokens:number;source:string} {
  if(cfg.contextMode!=='auto' && Number.isFinite(cfg.contextWindow) && cfg.contextWindow!>=8192)
    return {tokens:cfg.contextWindow!,source:cfg.contextMode==='manual'?'手动覆盖':'已有手动配置（可切换自动）'};
  const metadata=cfg.modelLimits?.scope===modelScope(cfg.baseUrl)?cfg.modelLimits.models[model]:undefined;
  if(metadata?.context_window && Number.isFinite(metadata.context_window) && metadata.context_window>=8192)
    return {tokens:metadata.context_window,source:'当前接口 /models 元数据'};
  // Match known model IDs only. Official presets do not guarantee a gateway deployment's limit.
  const id=model.toLowerCase().replace(/^deepseek\//,'');
  if(/^(deepseek-v4(?:\.1)?-(?:pro|flash)(?:-\d{4})?|deepseek-flash)$/.test(id))
    return {tokens:1048576,source:'DeepSeek 官方规格预设（2026-11-09）；网关限制请手动覆盖'};
  return {tokens:65536,source:'未知模型保守回退 64K，请拉取模型元数据或手动配置'};
}
export function autoCompactThreshold(capacity:number):number {return Math.max(1000,Math.floor(capacity*0.6));}

export function parseModelLimits(rows:unknown):Record<string,ModelLimits> {
  const out:Record<string,ModelLimits>={};
  if(!Array.isArray(rows))return out;
  for(const row of rows) {
    if(!row||typeof row.id!=='string')continue;
    const window=row.context_window??row.context_length;
    const max=row.max_output_tokens??row.top_provider?.max_completion_tokens;
    out[row.id]={...(Number.isFinite(window)&&window>=8192?{context_window:window}:{}),...(Number.isFinite(max)&&max>0?{max_output_tokens:max}:{})};
  }
  return out;
}
