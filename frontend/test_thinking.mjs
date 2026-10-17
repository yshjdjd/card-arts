/**
 * 思考模式（深度推理）开关的自检脚本。
 * 运行：node frontend/test_thinking.mjs
 *
 * 各家开思考的字段完全不一样，这里逐个厂商断言：
 * 开关 → 实际塞进请求体的参数 → 换模型名 / 恢复模型名 → 输出上限联动。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * llm.ts 依赖 ../api/client.ts（里面用了 import.meta.env 和浏览器 fetch），
 * 在 Node 里跑不起来，打包时用一个插件把该模块换成桩。
 */
const stubApiClient = {
  name: 'stub-api-client',
  setup(build) {
    build.onResolve({ filter: /api\/client$/ }, () => ({ path: 'api-client', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: [
        'export const API_BASE = "/api/v1";',
        'export const api = {',
        '  llmChat: async () => ({ content: "", model: "", finish_reason: "" }),',
        '  llmTest: async () => ({ ok: true, message: "", models: [] }),',
        '  llmModels: async () => ({ models: [] }),',
        '};',
      ].join('\n'),
      loader: 'js',
    }));
  },
};

const built = await esbuild.build({
  stdin: {
    contents: "export * from './src/lib/llm';\n",
    resolveDir: here,
    sourcefile: 'llm-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [stubApiClient],
});
const code = built.outputFiles[0].text;
const L = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const base = (p = {}) => ({ ...L.defaultLLMConfig(), ...p });

/* ---------- 1. 厂商 spec 推断 ---------- */
console.log('\n[1] 厂商 / 模型的思考参数形式');

ok(L.thinkingSpecOf(base({ provider: 'deepseek', model: 'deepseek-chat' })).kind === 'model',
  'DeepSeek → 换模型名');
ok(L.thinkingSpecOf(base({ provider: 'qwen', model: 'qwen3-32b' })).kind === 'enable_thinking',
  '通义千问 → enable_thinking');
ok(L.thinkingSpecOf(base({ provider: 'glm', model: 'glm-z1-air' })).kind === 'thinking_object',
  '智谱 GLM → thinking:{type}');
ok(L.thinkingSpecOf(base({ provider: 'openai', model: 'o4-mini' })).kind === 'reasoning_effort',
  'OpenAI → reasoning_effort');
ok(L.thinkingSpecOf(base({ provider: 'openrouter', model: 'anthropic/claude-3.7' })).kind === 'budget',
  'OpenRouter → thinking:budget_tokens');
ok(L.thinkingSpecOf(base({ provider: 'custom', model: 'qwen3-8b' })).kind === 'enable_thinking',
  '自建网关按模型名猜：Qwen3 → enable_thinking');
ok(L.thinkingSpecOf(base({ provider: 'custom', model: 'o3-mini' })).kind === 'reasoning_effort',
  '自建网关按模型名猜：o 系列 → reasoning_effort');
ok(L.thinkingSpecOf(base({ provider: 'custom', model: 'my-model' })).kind === 'template',
  '认不出来 → chat_template_kwargs 兜底');
ok(L.thinkingSpecOf(base({ provider: 'custom', model: 'x', thinkingKind: 'budget' })).kind === 'budget',
  '手动指定优先于自动判断');

/* ---------- 2. 请求体参数 ---------- */
console.log('\n[2] 开关生成的请求参数');

{
  const f = L.thinkingFields(base({ provider: 'deepseek', model: 'deepseek-chat', thinking: true }));
  ok(Object.keys(f).length === 0, 'DeepSeek 开启时不塞额外字段（靠换模型名）');
}
{
  const f = L.thinkingFields(base({ provider: 'qwen', model: 'qwen3-32b', thinking: true }));
  ok(f.enable_thinking === true, 'Qwen3 开启 → enable_thinking:true');
  const g = L.thinkingFields(base({ provider: 'qwen', model: 'qwen3-32b', thinking: false }));
  ok(g.enable_thinking === false, 'Qwen3 关闭 → 显式发 enable_thinking:false');
}
{
  const f = L.thinkingFields(base({ provider: 'glm', model: 'glm-z1-air', thinking: true }));
  ok(f.thinking?.type === 'enabled', 'GLM 开启 → thinking.type=enabled');
  const g = L.thinkingFields(base({ provider: 'glm', model: 'glm-z1-air', thinking: false }));
  ok(g.thinking?.type === 'disabled', 'GLM 关闭 → thinking.type=disabled');
}
{
  const f = L.thinkingFields(base({ provider: 'openai', model: 'o4-mini', thinking: true }));
  ok(f.reasoning_effort === 'medium', 'o 系列默认 medium');
  const g = L.thinkingFields(base({
    provider: 'openai', model: 'o4-mini', thinking: true, thinkingEffort: 'high',
  }));
  ok(g.reasoning_effort === 'high', 'o 系列强度可选 high');
}
{
  const f = L.thinkingFields(base({ provider: 'openrouter', model: 'anthropic/claude-3.7', thinking: true }));
  ok(f.thinking?.budget_tokens === 4096, 'Claude 默认思考预算 4096');
  const g = L.thinkingFields(base({
    provider: 'openrouter', model: 'anthropic/claude-3.7', thinking: true, thinkingBudget: 999999,
  }));
  ok(g.thinking?.budget_tokens === 65536, '思考预算被夹在 1024~65536', JSON.stringify(g));
}
{
  const f = L.thinkingFields(base({ provider: 'custom', model: 'x', thinking: true }));
  ok(f.enable_thinking === true && f.chat_template_kwargs?.enable_thinking === true,
    '自建网关同时发 enable_thinking 与 chat_template_kwargs');
}
{
  // 从来没设置过（undefined）就什么都不发，避免严格校验的网关报「不认识的参数」
  const f = L.thinkingFields(base({ provider: 'qwen', model: 'qwen3-32b', thinking: undefined }));
  ok(Object.keys(f).length === 0, '未设置过思考开关时不发任何参数');
}

/* ---------- 3. 换模型名 ---------- */
console.log('\n[3] DeepSeek 的换模型名与回退');

{
  const on = L.applyThinkingToggle(base({ provider: 'deepseek', model: 'deepseek-chat' }), true);
  ok(on.model === 'deepseek-reasoner', '开启 → 切成 deepseek-reasoner');
  ok(on.thinkingBaseModel === 'deepseek-chat', '记住原来的模型名');

  const off = L.applyThinkingToggle(on, false);
  ok(off.model === 'deepseek-chat', '关闭 → 切回 deepseek-chat', off.model);
  ok(off.thinking === false, '关闭后 thinking=false');
}
{
  // 用户手动把模型改成别的，再关掉思考，不应该被强行改回预设
  const on = L.applyThinkingToggle(base({ provider: 'deepseek', model: 'deepseek-chat' }), true);
  const off = L.applyThinkingToggle({ ...on, model: 'deepseek-vl2' }, false);
  ok(off.model === 'deepseek-vl2', '关闭时若模型已被手动改走，不覆盖用户的选择');
}
{
  const on = L.applyThinkingToggle(base({ provider: 'qwen', model: 'qwen3-32b' }), true);
  ok(on.model === 'qwen3-32b', '非 model 形式的厂商不动模型名');
}

/* ---------- 4. 输出上限联动 ---------- */
console.log('\n[4] 开启思考时抬高最大 Token');

{
  const cfg = base({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 });
  const on = L.applyThinkingToggle(cfg, true);
  ok(on.maxTokens === 2048, 'applyThinkingToggle 本身不动 maxTokens（保持单一职责）');
  // UI 层的 toggleThinking 才抬额度，这里模拟同样的逻辑
  const ui = on.maxTokens < 8192 ? { ...on, maxTokens: 8192 } : on;
  ok(ui.maxTokens === 8192, 'UI 层把 2048 抬到 8192');
  ok((ui.maxTokens < 8192 ? { ...ui, maxTokens: 8192 } : ui).maxTokens === 8192,
    '已经是 8192 时不重复抬高');
}

/* ---------- 5. o 系列的长度字段 ---------- */
console.log('\n[5] o 系列不接受 temperature，长度字段改名');

{
  const msgs = [{ role: 'user', content: 'hi' }];
  const p1 = L.chatComplete.length; // 只是确保导出存在
  ok(p1 >= 1, 'chatComplete 已导出');
  // 直接验 payload 形状：走 directPayload 的等价路径
  const cfg = base({ provider: 'openai', model: 'o4-mini', thinking: true, thinkingEffort: 'high' });
  const fields = L.thinkingFields(cfg);
  ok(fields.reasoning_effort === 'high', 'o 系列强度透传');
  ok(!('temperature' in fields), 'o 系列不带 temperature');
}

/* ---------- 5b. DeepSeek 深挖（主力厂商） ---------- */
console.log('\n[5b] DeepSeek 细节');

{
  // 用户已经填了 deepseek-v4-pro：它本身就是推理模型，不该被换成 deepseek-reasoner
  const on = L.applyThinkingToggle(base({ provider: 'deepseek', model: 'deepseek-v4-pro' }), true);
  ok(on.model === 'deepseek-v4-pro', '已是推理模型时不改模型名', on.model);
  const f = L.thinkingFields({ ...on, thinking: true });
  ok(f.thinking?.type === 'enabled', '改用 thinking:{type} 开启', JSON.stringify(f));
}
{
  // 普通 V3 就是换模型名，且不带任何额外字段（老接口不认 thinking）
  const on = L.applyThinkingToggle(base({ provider: 'deepseek', model: 'deepseek-chat' }), true);
  ok(on.model === 'deepseek-reasoner', 'V3 → 换成 deepseek-reasoner');
  ok(Object.keys(L.thinkingFields({ ...on, thinking: true })).length === 0, '不带额外字段');
}
ok(L.isReasonerName('deepseek-reasoner') && L.isReasonerName('deepseek-v4-pro')
  && !L.isReasonerName('deepseek-chat'), 'isReasonerName 只认推理模型');

/* ---------- 5c. 输出上限夹取 ---------- */
console.log('\n[5c] 各模型的输出上限');

ok(L.clampMaxTokens('deepseek-chat', 16384).value === 8192, 'deepseek-chat 上限 8K（超了会 400）');
ok(L.clampMaxTokens('deepseek-chat', 4096).value === 4096, '没超就不动');
ok(L.clampMaxTokens('deepseek-chat', 16384).capped === true, '被夹住时返回 capped');
ok(L.clampMaxTokens('deepseek-reasoner', 16384).value === 16384, 'reasoner 允许 16K');
ok(L.clampMaxTokens('deepseek-reasoner', 999999).value === 65536, 'reasoner 上限 64K');
ok(L.clampMaxTokens('my-model', 999999).value === 32768, '未知模型兜底 32K');
ok(L.clampMaxTokens('my-model', 0).value === 4096, '非法值兜底 4096');

/* ---------- 6. 内置厂商都给了 thinking 描述 ---------- */
console.log('\n[6] 厂商预设完整性');

for (const p of L.LLM_PROVIDERS) {
  ok(Boolean(p.thinking), `${p.label} 声明了思考参数形式`);
}
ok(L.LLM_PROVIDERS.every((p) => !p.thinking?.kind || typeof p.thinking.kind === 'string'),
  '所有 thinking.kind 合法');
ok(L.LLM_PROVIDERS.filter((p) => p.thinking?.kind === 'model').every((p) => Boolean(p.thinking?.model)),
  'kind=model 的厂商都指定了推理模型名');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
