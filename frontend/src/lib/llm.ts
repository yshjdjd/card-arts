/**
 * OpenAI 兼容的大模型客户端。
 *
 * 两条通道：
 *   1. 直连：浏览器直接请求厂商 endpoint，需要厂商允许 CORS；
 *   2. 代理：经由本地后端 /api/v1/llm/* 转发，规避跨域，密钥只在本机流转。
 *
 * 所有厂商统一走 POST {base}/chat/completions，请求/响应结构与 OpenAI 一致。
 */
import { API_BASE, api } from '../api/client';
import { readSSE, StreamError } from './agentStream';
import type { ChatMessage, LLMConfig, LLMProvider, ThinkingSpec } from './types';

/* ---------------- 厂商预设 ---------------- */

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    corsOk: true,
    hint: '官方接口，浏览器可直连（注意额度与密钥安全）',
    thinking: {
      kind: 'reasoning_effort',
      efforts: ['low', 'medium', 'high'],
      hint: 'o 系列（o3 / o4-mini 等）原生就是推理模型，开关实际调的是推理强度；gpt-4o 等普通模型不支持，会被上游忽略。',
    },
  },
  {
    key: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro'],
    corsOk: false,
    hint: '性价比高，建议走本地代理',
    thinking: {
      kind: 'model',
      model: 'deepseek-reasoner',
      baseModel: 'deepseek-chat',
      hint: '开启后模型名自动切成 deepseek-reasoner，关闭时切回原模型。注意：思维链（reasoning_content）占用同一个 max_tokens 额度，最多可到 32K，所以开启时建议把最大 Token 设到 16384 以上，否则思维链会先把配额吃光，正文和工具 JSON 反而被截断。思考模式下 temperature 不生效（传了也不报错）。',
    },
  },
  {
    key: 'qwen',
    label: '通义千问（阿里云）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen3-32b', 'qwen3-235b-a22b'],
    corsOk: false,
    thinking: {
      kind: 'enable_thinking',
      hint: '仅 Qwen3 系列支持；qwen-max / plus / turbo 等旧模型会忽略该参数。',
    },
  },
  {
    key: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2.6', 'kimi-k3'],
    corsOk: false,
    thinking: {
      kind: 'thinking_object',
      hint: 'K2.x 走 thinking:{type}；K3 改成顶层 reasoning_effort（会自动识别）。moonshot-v1-* 不支持思考。',
    },
  },
  {
    key: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-long', 'glm-z1-air', 'glm-z1-flash'],
    corsOk: false,
    thinking: {
      kind: 'thinking_object',
      hint: '走 thinking: {type} 字段；老模型 glm-4-plus / air / flash 会忽略，用 glm-z1-* 效果更明显。',
    },
  },
  {
    key: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat', 'Qwen/Qwen3-32B'],
    corsOk: false,
    thinking: {
      kind: 'enable_thinking',
      hint: '带 thinking 的模型（如 deepseek-ai/DeepSeek-R1、Qwen/Qwen3-*）才生效。',
    },
  },
  {
    key: 'doubao',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k', 'doubao-lite-32k'],
    corsOk: false,
    hint: 'endpoint id 形如 ep-xxxx，直接填到模型名里',
    thinking: {
      kind: 'thinking_object',
      hint: '豆包 seed 系列走 thinking:{type}（enabled / disabled / auto）；老模型 doubao-pro/lite 会忽略。',
    },
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-r1'],
    corsOk: true,
    thinking: {
      kind: 'budget',
      efforts: ['1024', '4096', '8192', '16384'],
      hint: '走 Anthropic 风格 thinking: {type, budget_tokens}；Claude 系与部分推理模型生效，其余会忽略。',
    },
  },
  {
    key: 'ollama',
    label: 'Ollama（本机）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b'],
    corsOk: false,
    hint: '本机推理，apiKey 可留空；浏览器直连需设置 OLLAMA_ORIGINS',
    thinking: {
      kind: 'template',
      hint: '取决于具体模型（如 deepseek-r1:7b、qwen3）。走 chat_template_kwargs 传参，不支持的模型会忽略。',
    },
  },
  {
    key: 'custom',
    label: '自定义 / 自建网关',
    baseUrl: '',
    models: [],
    corsOk: false,
    hint: '任何 OpenAI 兼容端点（One-API、New API、LiteLLM 等）',
    thinking: {
      kind: 'template',
      hint: '自建网关没有统一标准，默认用最通用的 chat_template_kwargs 写法；不生效可在下面手动换参数形式。',
    },
  },
];

export function providerByKey(key: string): LLMProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.key === key);
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是 CardArts 的桌游创作助手，帮助用户设计卡牌、平衡数值、批量整理数据。用中文回答，简洁务实。';

export function defaultLLMConfig(): LLMConfig {
  return {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.3,
    // 助手要输出「说明文字 + 工具调用 JSON」，2048 经常不够（JSON 被截断就整个改不动），
    // 默认给 4096：常规任务够用，又不至于每次都烧满额度
    maxTokens: 4096,
    thinking: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    useProxy: true,
  };
}

/* ---------------- 思考模式 / 深度推理 ---------------- */

/**
 * 按模型名判断思考参数形式。
 * 只认「有把握」的信号，认不出来返回 undefined，交给厂商预设兜底 ——
 * 猜错比不猜更糟（发给不支持的字段，轻则忽略、重则 400）。
 */
export function guessThinkingSpec(model: string): ThinkingSpec | undefined {
  const m = (model || '').toLowerCase();
  if (/deepseek-v4|deepseek-flash/.test(m)) return { kind: 'thinking_object' };
  if (/deepseek-(chat|reasoner)$/.test(m)) return { kind: 'model', model: 'deepseek-reasoner', baseModel: 'deepseek-chat' };
  if (/^o\d/.test(m)) return { kind: 'reasoning_effort', efforts: ['low', 'medium', 'high'] };
  if (/kimi-k3/.test(m)) return { kind: 'reasoning_effort', efforts: ['low', 'high', 'max'] };
  if (/kimi-k2/.test(m)) return { kind: 'thinking_object' };
  if (/qwen3|qwq|qwen.*thinking/.test(m)) return { kind: 'enable_thinking' };
  if (/glm-z1|glm-4\.[56]|glm.*thinking/.test(m)) return { kind: 'thinking_object' };
  if (/claude/.test(m)) return { kind: 'budget', efforts: ['1024', '4096', '8192', '16384'] };
  return undefined;
}

export function thinkingState(cfg: LLMConfig): { on: boolean | undefined; locked: boolean; label: string } {
  if (/^(?:openai\/)?o\d/i.test(cfg.model.trim())) return { on: true, locked: true, label: '推理常开' };
  const spec = thinkingSpecOf(cfg);
  const on = cfg.thinking ?? (spec.kind === 'model'
    ? cfg.model === spec.model ? true : cfg.model === spec.baseModel ? false : undefined
    : undefined);
  return { on, locked: false, label: on === undefined ? '跟随模型默认' : on ? '思考开' : '思考关' };
}

export function resolveLLMConfig(cfg: LLMConfig, model = cfg.model): LLMConfig {
  const effective = { ...cfg, model };
  return typeof cfg.thinking === 'boolean' ? applyThinkingToggle(effective, cfg.thinking) : effective;
}

export function thinkingSpecOf(cfg: LLMConfig): ThinkingSpec {
  // 1) 用户手动指定了参数形式（自建网关常需要）
  if (cfg.thinkingKind) {
    const efforts =
      cfg.thinkingKind === 'reasoning_effort' ? ['low', 'medium', 'high']
        : cfg.thinkingKind === 'budget' ? ['1024', '4096', '8192', '16384']
          : undefined;
    const preset = providerByKey(cfg.provider)?.thinking;
    return {
      kind: cfg.thinkingKind,
      efforts,
      ...(preset?.model ? { model: preset.model, baseModel: preset.baseModel }
        : cfg.thinkingKind === 'model' && /deepseek/i.test(cfg.model) ? { model: 'deepseek-reasoner', baseModel: 'deepseek-chat' } : {}),
    };
  }
  // 2) 模型名能确定判断的优先（同一厂商里新旧模型可能两套写法，如 Kimi K2 / K3）
  const byModel = guessThinkingSpec(cfg.model);
  if (byModel) return byModel;
  // 3) 否则用厂商预设
  const preset = providerByKey(cfg.provider)?.thinking;
  if (preset) return preset;
  // 4) 都不认识 → 最通用的 chat_template_kwargs
  return { kind: 'template' };
}

/**
 * 各模型自己的输出上限。超过会被厂商直接 400（deepseek-chat 只有 8K），
 * 与其让用户撞错，不如在发出前夹住。
 */
export const MODEL_TOKEN_CAP: Array<[RegExp, number]> = [
  [/^deepseek-chat$/i, 8192],
  [/^deepseek-reasoner$/i, 65536],
  [/^deepseek-v\d/i, 65536],
  [/^glm-4-flash/i, 16384],
  [/^glm-z1-flash/i, 16384],
];

export function clampMaxTokens(model: string, n: number): { value: number; capped: boolean } {
  if (!Number.isFinite(n) || n <= 0) return { value: 4096, capped: false };
  for (const [re, cap] of MODEL_TOKEN_CAP) {
    if (re.test(model.trim())) return { value: Math.min(n, cap), capped: n > cap };
  }
  return { value: Math.min(n, 32768), capped: n > 32768 };
}

/**
 * 生成要塞进请求体的思考参数。
 * 关闭时也要显式发 false，否则部分模型（Qwen3、GLM）会沿用默认开启的行为。
 */
export function thinkingFields(cfg: LLMConfig): Record<string, unknown> {
  const spec = thinkingSpecOf(cfg);
  if (cfg.thinking === true) {
    switch (spec.kind) {
      case 'reasoning_effort':
        return { reasoning_effort: cfg.thinkingEffort || 'medium' };
      case 'enable_thinking':
        return { enable_thinking: true };
      case 'thinking_object':
        return { thinking: { type: 'enabled' } };
      case 'budget': {
        const raw = Number(cfg.thinkingBudget || cfg.thinkingEffort || 4096);
        const b = Number.isFinite(raw) ? Math.min(Math.max(raw, 1024), 65536) : 4096;
        return { thinking: { type: 'enabled', budget_tokens: b } };
      }
      case 'template':
        return { enable_thinking: true, chat_template_kwargs: { enable_thinking: true } };
      default: {
        // kind==='model'：换模型名就够了（DeepSeek 官方推荐做法）。
        // 但若用户自己填的就已经是推理模型（如 deepseek-v4-pro），改用 thinking 字段开。
        const cur = (cfg.model || '').trim();
        if (spec.model && cur !== spec.model && isReasonerName(cur)) {
          return { thinking: { type: 'enabled' } };
        }
        return {};
      }
    }
  }
  // 只有用户明确关掉过才发 false；没设置过就什么都不发，免得招来「不认识的参数」报错
  if (cfg.thinking === false) {
    switch (spec.kind) {
      case 'enable_thinking':
        return { enable_thinking: false };
      case 'thinking_object':
        return { thinking: { type: 'disabled' } };
      case 'budget':
        return { thinking: { type: 'disabled' } };
      case 'template':
        return { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
      default:
        return {};
    }
  }
  return {};
}

/** 名字本身就说明是推理模型（DeepSeek 官方两种开法之一） */
export function isReasonerName(model: string): boolean {
  return /reasoner|[-_]r1|deepseek-v\d/i.test((model || '').trim());
}

/** 切换开关：DeepSeek 这类靠换模型名的，顺带把模型名切了 / 切回来 */
export function applyThinkingToggle(cfg: LLMConfig, on: boolean): LLMConfig {
  const spec = thinkingSpecOf(cfg);
  const next: LLMConfig = { ...cfg, thinking: on };
  if (spec.kind !== 'model' || !spec.model) return next;
  // 用户填的已经是推理模型（如 deepseek-v4-pro）：不用换名，靠 thinking 字段开关
  if (on && isReasonerName(cfg.model) && cfg.model !== spec.model) return next;
  if (on) {
    if (cfg.model && cfg.model !== spec.model) next.thinkingBaseModel = cfg.model;
    next.model = spec.model;
  } else {
    const back = cfg.thinkingBaseModel || spec.baseModel;
    if (cfg.model === spec.model && back) next.model = back;
  }
  return next;
}

/** OpenAI o 系列不认 temperature，且长度字段叫 max_completion_tokens */
function isOA(model: string): boolean {
  return /^o\d/i.test(model.trim());
}

/** DeepSeek 思考模式下 temperature 传了也不生效（不报错，但没意义），直接不发 */
function noTemperature(model: string): boolean {
  return isOA(model) || /deepseek-reasoner|deepseek-v\d/i.test(model.trim());
}

/* ---------------- 请求 ---------------- */

export interface ChatChunk {
  delta: string;
  done: boolean;
}

export interface ChatParams {
  cfg: LLMConfig;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  onDelta?: (text: string) => void;
  /**
   * 上游给的结束原因：`length` = 被 max_tokens 掐断（要提示用户调大），
   * `stop` = 正常说完。拿不到时空串。
   */
  onFinish?: (reason: string) => void;
  /** 思考过程增量（开启思考模式时才有，和正文分开） */
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}

function endpointOf(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (!b) throw new Error('未填写接口地址');
  return `${b}/chat/completions`;
}

function directPayload(params: ChatParams, stream: boolean) {
  const { cfg, messages, model, temperature, maxTokens } = params;
  const effective = resolveLLMConfig(cfg, model || cfg.model);
  const name = effective.model;
  const { value: limit } = clampMaxTokens(name, maxTokens ?? cfg.maxTokens);
  const body: Record<string, unknown> = { model: name, messages, stream };
  if (isOA(name)) {
    // o1 / o3 / o4-mini：长度字段改名，且不接受 temperature（传了会 400）
    body.max_completion_tokens = limit;
  } else {
    body.max_tokens = limit;
    if (!noTemperature(name)) body.temperature = temperature ?? cfg.temperature;
  }
  return { ...body, ...thinkingFields(effective) };
}

/** 非流式：一次性拿完整回复。代理通道失败（后端没起）会自动退回直连。 */
export async function chatComplete(params: ChatParams): Promise<string> {
  const { cfg, signal, onFinish, onReasoning } = params;
  const payload = directPayload(params, false);

  if (cfg.useProxy) {
    try {
      const res = await api.llmChat({
        base_url: cfg.baseUrl,
        api_key: cfg.apiKey,
        model: payload.model as string,
        messages: payload.messages as Array<{ role: string; content: string }>,
        temperature: payload.temperature as number | undefined,
        max_tokens: payload.max_tokens as number | undefined,
        max_completion_tokens: payload.max_completion_tokens as number | undefined,
        extra: thinkingFields({ ...cfg, model: String(payload.model) }),
      }, signal);
      onFinish?.(res.finish_reason ?? '');
      if (res.reasoning) onReasoning?.(res.reasoning);
      return res.content ?? '';
    } catch (e) {
      // status 0 = 连不上本地后端（多半没启动），退回直连再试
      const status = (e as { status?: number }).status;
      if (signal?.aborted || status !== 0) throw e;
    }
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const res = await fetch(endpointOf(cfg.baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  onFinish?.(body?.choices?.[0]?.finish_reason ?? '');
  const msg = body?.choices?.[0]?.message ?? {};
  const rc: string = msg?.reasoning_content ?? msg?.reasoning ?? '';
  if (rc) onReasoning?.(rc);
  return msg?.content ?? '';
}

/** 代理通道的流式：后端把上游 SSE 原样透传回来，前端逐字渲染 */
async function proxyStream(params: ChatParams): Promise<string> {
  const { cfg, onDelta, signal, onFinish, onReasoning } = params;
  const payload = directPayload(params, true);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/llm/chat`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: cfg.baseUrl,
        api_key: cfg.apiKey,
        model: payload.model,
        messages: payload.messages,
        temperature: payload.temperature,
        max_tokens: payload.max_tokens,
        max_completion_tokens: payload.max_completion_tokens,
        stream: true,
        extra: thinkingFields({ ...cfg, model: String(payload.model) }),
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError' || e instanceof StreamError) throw e;
    // 后端没起（status 0）→ 退回直连
    return directStream(params);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`后端代理返回 ${res.status}：${text.slice(0, 300)}`);
  }
  return readStreamResponse(res, params);
}

/** Some compatible gateways return JSON even when stream=true; consume that same response. */
async function readStreamResponse(res: Response, params: ChatParams): Promise<string> {
  if (/application\/json/i.test(res.headers.get('content-type') || '')) {
    const body = await res.json();
    if (body.error) throw new StreamError(typeof body.error === 'string' ? body.error : body.error.message || '模型服务发生错误');
    const choice = body.choices?.[0];
    if (!choice) throw new StreamError('模型返回缺少 choices');
    params.onFinish?.(choice.finish_reason || '');
    const message = choice.message || {};
    const reasoning = message.reasoning_content || message.reasoning;
    if (reasoning) params.onReasoning?.(reasoning);
    const content = message.content || '';
    if (content) params.onDelta?.(content);
    return content;
  }
  if (!res.body) throw new StreamError('模型返回空响应');
  return readSSE(res.body, params.onDelta, params.signal, params.onFinish, params.onReasoning);
}

/** 直连通道的流式 */
async function directStream(params: ChatParams): Promise<string> {
  const { cfg, onDelta, signal, onFinish, onReasoning } = params;
  const payload = directPayload(params, true);

  let res: Response;
  try {
    res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError' || e instanceof StreamError) throw e;
    // 直连失败（多半是 CORS）时退回非流式再试一次
    return chatComplete({ ...params, cfg: { ...cfg, useProxy: false } });
  }
  if (!res.ok) throw new Error(`模型返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  return readStreamResponse(res, params);
}

/** 流式：逐段把文字交给 onDelta（失败自动降级为非流式） */
export async function chatStream(params: ChatParams): Promise<string> {
  // Only fetch failures before receiving a response may switch channels.
  // Empty completions, upstream errors and interrupted streams must not trigger another generation.
  return params.cfg.useProxy ? proxyStream(params) : directStream(params);
}

/** 连通性测试：用一条极短的消息探活 */
export async function testConnection(cfg: LLMConfig): Promise<{ ok: boolean; msg: string; models?: string[] }> {
  const probe = async (useProxy: boolean): Promise<{ ok: boolean; msg: string; models?: string[] }> => {
    const c = { ...cfg, useProxy };
    if (useProxy) {
      const r = await api.llmTest({ base_url: cfg.baseUrl, api_key: cfg.apiKey, model: cfg.model });
      return { ok: r.ok, msg: r.message, models: r.models };
    }
    const t0 = Date.now();
    const text = await chatComplete({
      cfg: c,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });
    return { ok: true, msg: `连通正常（${Date.now() - t0}ms）：${text.slice(0, 40) || '已响应'}` };
  };

  try {
    return await probe(cfg.useProxy);
  } catch (e) {
    const status = (e as { status?: number }).status;
    // 后端没起 → 再试一次直连；直连不通才判定失败
    if (cfg.useProxy && status === 0) {
      try {
        const r = await probe(false);
        return { ...r, msg: `${r.msg}（后端代理不可用，本次为浏览器直连）` };
      } catch (e2) {
        return { ok: false, msg: `直连失败：${(e2 as Error).message}。同时本地后端也没响应，请确认后端已启动。` };
      }
    }
    const m = (e as Error).message ?? '';
    if (/Failed to fetch|NetworkError|CORS|网络不可达/i.test(m)) {
      return { ok: false, msg: '浏览器无法直连该地址（跨域或网络不通），请勾选「经由本地后端转发」后重试' };
    }
    return { ok: false, msg: m };
  }
}

/** 拉取远端模型列表（GET {base}/models） */
export async function fetchModels(cfg: LLMConfig): Promise<string[]> {
  try {
    if (cfg.useProxy) {
      try {
        const r = await api.llmModels({ base_url: cfg.baseUrl, api_key: cfg.apiKey });
        return r.models ?? [];
      } catch (e) {
        if ((e as { status?: number }).status !== 0) throw e;
        // 后端没起，退回直连
      }
    }
    const b = cfg.baseUrl.trim().replace(/\/+$/, '');
    const res = await fetch(`${b}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j?.data ?? []).map((x: { id: string }) => x.id).filter(Boolean);
  } catch {
    return [];
  }
}

/** 把会话里的历史消息裁剪成模型可接受的输入 */
export function toPromptMessages(
  history: ChatMessage[],
  systemPrompt: string,
  userText: string,
  limit = 24,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const recent = history
    .filter((m) => m.role !== 'system')
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
  return [
    { role: 'system' as const, content: systemPrompt },
    ...recent,
    { role: 'user' as const, content: userText },
  ];
}
