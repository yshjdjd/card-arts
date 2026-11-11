/** 从实际协议导出文档附件：在 frontend 中运行 node export_agent_reference.mjs。 */
import {build} from 'esbuild';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('./src/lib/agentProtocol.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const protocol=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const definitions=protocol.buildToolDefinitions();
const tools=protocol.TOOL_SPECS.map(spec=>({name:spec.name,wireName:protocol.toWireName(spec.name),level:spec.level,description:spec.doc,parameters:definitions.find(t=>t.function.name===protocol.toWireName(spec.name)).function.parameters}));
await writeFile(new URL('../docs/Agent工具参数.json',import.meta.url),JSON.stringify({source:'frontend/src/lib/agentProtocol.ts',tools},null,2)+'\n','utf8');
console.log(`已导出 ${tools.length} 个核心工具的参数 schema。`);
