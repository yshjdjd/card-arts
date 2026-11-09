import { contextTokens } from './agentContext';

export function systemBreakdown(text: string): Record<string,number> {
  const totals: Record<string,number> = {'系统规则':0,'工程快照':0,'任务记忆与固定约束':0,'挂载知识包':0,'挂载文档':0,'待办':0};
  let category='任务记忆与固定约束';
  for(const line of text.split(/(?<=\n)/)) {
    if(line.startsWith('你是 CardArts'))category='系统规则';
    else if(line.startsWith('## 当前工程快照'))category='工程快照';
    else if(line.startsWith('## 参考资料：知识包'))category='挂载知识包';
    else if(line.startsWith('## 参考资料：项目文档'))category='挂载文档';
    else if(line.startsWith('## 当前待办'))category='待办';
    else if(line.startsWith('## 调用规则')||line.startsWith('## 用户附加要求'))category='系统规则';
    totals[category]+=contextTokens(line);
  }
  return totals;
}
