import { db } from './schema';

export async function saveToolResult(chatId: string, tool: string, content: string): Promise<string> {
  const ref = crypto.randomUUID();
  await db.agentResults.put({ chatId, ref, tool, content, createdAt: new Date().toISOString() });
  return ref;
}

export function resultTools(chatId: string) {
  return {
    'conversation.readResult': async (args: Record<string, unknown>) => {
      const row = await db.agentResults.get([chatId, String(args.ref ?? '')]);
      if (!row) return '❌ 结果引用不存在或不属于当前会话';
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const content = row.content.slice(offset, offset + 2400);
      return JSON.stringify({ ref: row.ref, tool: row.tool, content, total: row.content.length,
        nextOffset: offset + 2400 < row.content.length ? offset + 2400 : null });
    },
  };
}
