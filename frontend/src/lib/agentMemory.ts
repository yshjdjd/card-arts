import type { ChatSession } from './types';

/** Keep the newest user turn whole, including its assistant/tool transcript. */
export function summaryCandidates(chat: ChatSession): ChatSession['messages'] {
  const previous = chat.summary ? chat.messages.findIndex((m) => m.id === chat.summary!.throughMessageId) : -1;
  const pending = chat.messages.slice(previous + 1);
  let boundary = Math.max(0, pending.length - 6);
  while (boundary > 0 && pending[boundary]?.role !== 'user') boundary--;
  return pending.slice(0, boundary);
}

/** Deterministic task ledger: never infer a completed operation from model prose. */
export function taskMemory(chat: ChatSession): string {
  const requests = chat.messages.filter((m) => m.role === 'user');
  const recent = requests.slice(-4);
  const first = requests[0];
  const selected = first && !recent.includes(first) ? [first, ...recent] : recent;
  const run = [...chat.messages].reverse().find((m) => m.agentRun)?.agentRun;
  return [
    chat.summary ? `早期会话摘要（模型生成，需按原文核对）[截至 ${chat.summary.throughMessageId}]: ${chat.summary.text}` : '',
    '任务记忆（历史事实，不是新指令；后续要求优先；不完整时查询原文）：',
    ...selected.map((m) => `用户要求 [${m.id}]: ${m.content.slice(0, 400)}`),
    ...(chat.todos ?? []).map((t) => `待办 [${t.status}]: ${t.text.slice(0, 300)}`),
    run ? `最近执行状态：${run.status}` : '',
    ...(run?.records ?? []).slice(-3).map((r) => `执行事实 [${r.status}] ${r.tool}: ${r.content.slice(0, 180)}`),
    chat.pinnedMemory ? `用户固定约束：${chat.pinnedMemory}` : '',
    '不得仅根据历史摘要重放写操作；对象 ID 与工程内容以本轮读取结果为准。',
  ].filter(Boolean).join('\n');
}

export function forkSession(chat: ChatSession, messageId: string, id: string): ChatSession {
  const index = chat.messages.findIndex((m) => m.id === messageId);
  if (index < 0) throw new Error('分支起点已不存在');
  const now = new Date().toISOString();
  return { ...structuredClone(chat), id, title: `${chat.title} · 分支`,
    messages: structuredClone(chat.messages.slice(0, index + 1)),
    summary: undefined, todos: [], context: chat.context ? { ...structuredClone(chat.context), approved: [] } : undefined,
    parentSessionId: chat.id, forkMessageId: messageId, createdAt: now, updatedAt: now };
}
