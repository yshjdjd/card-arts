import { api, type McpRemoteTool } from '../api/client';
import type { AgentActions, ToolDefinition } from './agentProtocol';

export interface RemoteTools {
  defs: ToolDefinition[];
  tools: McpRemoteTool[];
  errors: Array<{ server: string; error: string }>;
  count: number;
}

/** 拉取后端已连接的外部 MCP server 工具，转成 function calling 定义。 */
export async function fetchRemoteTools(signal?: AbortSignal): Promise<RemoteTools> {
  try {
    const res = await api.mcpListTools(signal);
    const tools = res.tools ?? [];
    return {
      tools,
      defs: tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name, // 已是 mcp__<server>__<tool>（双下划线，符合 function calling 命名规范）
          description: `${t.description || '(外部 MCP 工具)'}\n来源：MCP server ${t.server}`,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      })),
      errors: res.errors ?? [],
      count: tools.length,
    };
  } catch {
    // 后端没起或没配 MCP：静默退化为「只有核心工具」，不影响主流程
    return { defs: [], tools: [], errors: [], count: 0 };
  }
}

/** 把每个 mcp.* 名字接到后端调用代理上。 */
export function buildMcpActions(tools: McpRemoteTool[]): AgentActions {
  const actions: AgentActions = {};
  for (const t of tools) {
    actions[t.name] = async (args, signal) => {
      const res = await api.mcpCallTool({ tool: t.name, arguments: args ?? {} }, signal);
      return res.content ?? '';
    };
  }
  return actions;
}
