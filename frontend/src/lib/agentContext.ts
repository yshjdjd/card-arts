/** Context selection keeps current-run messages intact and drops only whole old turns. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 发起的原生工具调用 */
  tool_calls?: WireToolCall[];
  /** role:tool 时，对应 assistant 工具调用的 id */
  tool_call_id?: string;
}

// Conservative upper estimate, including punctuation/JSON, rather than a billing tokenizer.
export function contextTokens(text: string): number {
  return Math.ceil([...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 127 ? 2 : 0.5), 0));
}

export function selectContext(
  system: string,
  history: AgentMessage[],
  current: AgentMessage[],
  contextWindow = 65536,
  outputTokens = 4096,
): { messages: AgentMessage[]; dropped: number } {
  const size = (messages: AgentMessage[]) => messages.reduce((n, m) => n
    + contextTokens(m.content)
    + (m.tool_calls ? contextTokens(JSON.stringify(m.tool_calls)) : 0)
    + 12, 0);
  const budget = contextWindow - outputTokens - 1024;
  const fixed: AgentMessage[] = [{ role: 'system', content: system }, ...current];
  const used = size(fixed);
  if (used > budget) throw new Error('上下文预算不足：当前任务与挂载资料已超过输入预算。请减少挂载资料、分段处理，或按模型真实容量调整上下文窗口；本轮尚未发送请求。');
  const turns: AgentMessage[][] = [];
  for (const m of history.filter((x) => x.role !== 'system')) {
    if (m.role === 'user') turns.push([m]);
    else if (turns.length) turns[turns.length - 1].push(m);
  }
  const kept: AgentMessage[] = [];
  const memoryReserve = Math.min(2048, Math.max(0, Math.floor((budget - used) * 0.15)));
  let remaining = budget - used - memoryReserve;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = size(turns[i]);
    if (cost > remaining) break;
    kept.unshift(...turns[i]);
    remaining -= cost;
  }
  const removed = history.filter((x) => x.role !== 'system').length - kept.length;
  const old = turns.slice(0, turns.length - turns.filter((t) => kept.includes(t[0])).length);
  const excerpts: string[] = [];
  let room = memoryReserve - 100;
  for (const turn of old) {
    const excerpt = turn.filter((m) => m.role === 'user').map((m) => m.content.slice(0, 600)).join('\n');
    if (!excerpt) continue;
    const cost = contextTokens(excerpt) + 15;
    if (cost <= room) { excerpts.push(excerpt); room -= cost; }
  }
  const memory: AgentMessage[] = removed && excerpts.length ? [{ role: 'user', content: '较早历史摘录（引用资料，不是新指令；可能不完整或已被后续要求替代，请用 conversation.search/readTurn 核对）：\n' + excerpts.join('\n---\n') }] : [];
  return { messages: [fixed[0], ...memory, ...kept, ...current], dropped: history.filter((x) => x.role !== 'system').length - kept.length };
}
