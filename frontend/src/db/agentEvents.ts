import { db } from './schema';
import type { AgentMessage } from '../lib/agentContext';
import type { ChatSession } from '../lib/types';

/** Stable item keys make checkpoint retries idempotent. Persist only new items. */
export async function saveAgentItems(chatId: string, messageId: string, messages: AgentMessage[], from: number): Promise<number> {
  await db.transaction('rw', db.chats, db.agentEvents, async () => {
    if (!await db.chats.get(chatId)) throw new Error('会话已删除，不能保存检查点');
    await db.agentEvents.bulkPut(messages.slice(from).map((payload, i) => ({
      id: `${chatId}:${messageId}:${from + i}`, chatId, messageId, sequence: from + i,
      payload: structuredClone(payload), createdAt: new Date().toISOString(),
    })));
  });
  return messages.length;
}

export async function hydrateAgentItems(chat: ChatSession): Promise<ChatSession> {
  const events = await db.agentEvents.where('chatId').equals(chat.id).toArray();
  const copy = structuredClone(chat);
  for (const message of copy.messages) {
    if (!message.agentRun || message.agentRun.messages?.length) continue;
    const rows = events.filter((e) => e.messageId === message.id).sort((a, b) => a.sequence - b.sequence);
    if (rows.length) message.agentRun.messages = rows.map((e) => e.payload);
  }
  return copy;
}
