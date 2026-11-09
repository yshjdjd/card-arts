import type { ChatMessage } from './types';
import type { AgentMessage } from './agentContext';

/** Display prose is not the execution transcript. Keep native call/result pairs intact. */
export function restoreHistory(messages: ChatMessage[]): AgentMessage[] {
  return messages.flatMap((m): AgentMessage[] => {
    if (m.role === 'assistant' && m.agentRun?.messages?.length) {
      const source = m.agentRun.messages;
      const answered = new Set(source.filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
      const transcript = source.map((x) => x.tool_calls ? { ...x, tool_calls: x.tool_calls.filter((c) => answered.has(c.id)) } : x);
      return [...transcript.slice(1), { role: 'assistant', content: `运行状态：${m.agentRun.status}。${m.agentRun.status === 'running' ? '上次运行被中断，先核对真实工程再继续。' : ''}` }];
    }
    return [{ role: m.role, content: m.content + (m.agentRun?.status === 'running'
      ? '\n上次运行在准备或请求阶段中断，未确认完成；先核对工程和执行记录，再继续。' : '') }];
  });
}

export function historyTools(messages: ChatMessage[]) {
  return {
    'conversation.search': async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').toLowerCase();
      if (!query) return '请提供 query';
      return JSON.stringify(messages.filter((m) => m.content.toLowerCase().includes(query)).slice(-20).map((m) => ({ id: m.id, role: m.role, excerpt: m.content.slice(0, 600) })));
    },
    'conversation.readTurn': async (args: Record<string, unknown>) => {
      const m = messages.find((m) => m.id === args.id);
      if (!m) return '未找到消息，请先 conversation.search';
      const offset = Math.max(0, Number(args.offset) || 0);
      return JSON.stringify({ id: m.id, content: m.content.slice(offset, offset + 6000), nextOffset: offset + 6000 < m.content.length ? offset + 6000 : null, status: m.agentRun?.status });
    },
  };
}
