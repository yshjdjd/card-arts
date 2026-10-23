import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useProject } from '../state/store';
import { useToast, useConfirm, Modal } from '../components/ui';
import {
  db, appendMessage, clearChatMessages, createChat, deleteChat, getLLMConfig,
  listChats, patchLastMessage, renameChat, setLLMConfig,
  updateChatContext, updateChatTodos,
} from '../db/schema';
import {
  applyThinkingToggle, chatStream, clampMaxTokens, fetchModels, isReasonerName,
  LLM_PROVIDERS, providerByKey, testConnection, thinkingSpecOf, thinkingState, resolveLLMConfig,
  DEFAULT_SYSTEM_PROMPT,
} from '../lib/llm';
import {
  buildSystemPrompt, buildToolDefinitions, callKey, createAgentActions, describeCall, estimateTokens,
  projectOverview, runToolCalls, TOOL_NAMES,
  type AgentActions, type PromptRef, type ToolCall,
} from '../lib/agentTools';
import { runAgent } from '../lib/agentRuntime';
import { fetchRemoteTools, buildMcpActions } from '../lib/mcp';
import type { RunResult, ToolRecord } from '../lib/agentProtocol';
import { allSkills, defaultSkillKeys } from '../lib/skills';
import type { AgentContext, ChatSession, LLMConfig, ProjectDocument, SkillDef, TodoItem } from '../lib/types';
import { formatDate } from '../lib/utils';

const WEB_PROVIDERS: { key: string; label: string; needKey: boolean }[] = [
  { key: 'auto', label: '自动（DuckDuckGo → 维基百科）', needKey: false },
  { key: 'duckduckgo', label: 'DuckDuckGo（免费，无需 Key）', needKey: false },
  { key: 'wikipedia', label: '维基百科（免费，无需 Key）', needKey: false },
  { key: 'tavily', label: 'Tavily（需 Key，质量最好）', needKey: true },
  { key: 'brave', label: 'Brave Search（需 Key）', needKey: true },
  { key: 'serper', label: 'Serper / Google（需 Key）', needKey: true },
];

/**
 * 项目内 AI 助手：多会话 + 项目级大模型配置 + 全工程工具调用。
 *
 * 仿 Claude Code 的几件事：
 *   · 上下文挂载：文档 / 知识包可勾选，动态拼进提示词前缀（也能用 @ 提及临时挂载）
 *   · 权限分级：只读自动并行、写入串行、删除类弹确认（可「本次会话都允许」）
 *   · 联网：web.search / web.fetch 由本地后端代跑，绕开浏览器跨域
 *   · 待办：todo.write 维护计划，界面上实时显示进度
 *
 * 两种模式：
 *   1. 启用模型 → OpenAI 兼容接口；模型可输出工具调用 JSON，精确改工程（带结果回传的多轮循环）
 *   2. 未启用   → 本地规则引擎，把几句固定指令映射到同样的工具上
 */
export default function AgentChat({ onClose }: { onClose: () => void }) {
  const { project, update, rename } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const projectId = project?.id ?? '';

  const [cfg, setCfg] = useState<LLMConfig | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'chats' | 'context' | 'config'>('chats');
  const boxRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 窗口位置：null 时走 CSS 默认（右下角），拖过之后用绝对坐标
  const [winPos, setWinPos] = useState<{ x: number; y: number } | null>(null);
  const winDrag = useRef<{ active: boolean; dx: number; dy: number; moved: boolean }>({
    active: false, dx: 0, dy: 0, moved: false,
  });
  const abortRef = useRef<AbortController | null>(null);
  const runLock = useRef(false);
  useEffect(() => () => abortRef.current?.abort(), [projectId]);

  // textarea 随内容自动增高（上限由 CSS max-height 控制）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [input]);

  /** 危险操作确认（三选一：拒绝 / 允许一次 / 本次会话都允许） */
  const [approveReq, setApproveReq] = useState<{
    call: ToolCall; resolve: (v: boolean | 'always') => void;
  } | null>(null);

  /** @ 提及弹出层 */
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    void getLLMConfig(projectId).then(setCfg);
  }, [projectId]);

  // 默认值为 undefined 表示「还没查完」；只有查完且确实为空时才自动建会话，
  // 否则每次打开聊天窗都会因为首帧空数组而多建一个会话。
  const sessions = useLiveQuery<ChatSession[], undefined>(
    () => (projectId ? listChats(projectId) : Promise.resolve(undefined as unknown as ChatSession[])),
    [projectId],
    undefined,
  );
  const chatList = sessions ?? [];
  const chatsLoaded = sessions !== undefined;

  // 换项目时清空当前选中，避免残留上一个项目的会话 id
  useEffect(() => { setActiveId(''); setFreshChat(null); }, [projectId]);

  // 只有在确认加载完毕且一个会话都没有时才创建，且项目内只建一次
  useEffect(() => {
    if (!projectId || !chatsLoaded || chatList.length > 0) return;
    let cancelled = false;
    void createChat(projectId, '会话 1').then((s) => {
      if (cancelled) return;
      setFreshChat(s);
      setActiveId(s.id);
    });
    return () => { cancelled = true; };
  }, [projectId, chatsLoaded, chatList.length]);

  // 没选中时自动落到最近更新的那个会话
  useEffect(() => {
    if (!activeId && chatList.length) setActiveId(chatList[0].id);
  }, [chatList, activeId]);

  // liveQuery 刷新有延迟：刚建好的会话还没进列表时，用它兜底，
  // 否则 active 会短暂为空（消息区一片空白）甚至看着像还停在旧会话上
  const [freshChat, setFreshChat] = useState<ChatSession | null>(null);
  const active = useMemo(
    () => chatList.find((s) => s.id === activeId)
      ?? (freshChat && freshChat.id === activeId ? freshChat : undefined),
    [chatList, activeId, freshChat],
  );

  useEffect(() => { boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight }); }, [active?.messages.length, busy]);

  const docs = useMemo(
    () => (project?.content?.documents ?? []) as ProjectDocument[],
    [project?.content?.documents],
  );

  /** 会话上下文：没存过就用「默认开启的知识包 + 允许联网」 */
  const agentCtx: AgentContext = useMemo(() => ({
    docIds: active?.context?.docIds ?? [],
    skills: active?.context?.skills ?? defaultSkillKeys(),
    customSkills: active?.context?.customSkills ?? [],
    web: active?.context?.web ?? true,
    webProvider: active?.context?.webProvider ?? 'auto',
    webApiKey: active?.context?.webApiKey ?? '',
    approved: active?.context?.approved ?? [],
  }), [active?.context]);

  // 切换会话时同步「已放行」清单

  const setCtx = useCallback(async (patch: Partial<AgentContext>) => {
    if (!activeId) return;
    await updateChatContext(activeId, patch);
  }, [activeId]);


  /* ---------------- 提示词前缀 ---------------- */

  /**
   * 把「工程快照 + 挂载的知识包 + 挂载的文档 + 待办」拼成系统提示词。
   * 每次请求都保留工具说明和挂载资料；模型服务不会记住被替换的系统消息。
   */
  const buildPrompt = useCallback(async (): Promise<string> => {
    const liveProject = await db.projects.get(projectId);
    const liveChat = await db.chats.get(activeId);
    const currentDocs = liveProject?.content?.documents ?? docs;
    const snapshot = await projectOverview({
      projectId, projectName: liveProject?.name ?? project?.name ?? '', update, rename,
    });
    const skills: PromptRef[] = allSkills(agentCtx.customSkills ?? [])
      .filter((s) => (agentCtx.skills ?? []).includes(s.key))
      .map((s) => ({ title: `${s.name}`, content: s.body }));
    const refs: PromptRef[] = (agentCtx.docIds ?? [])
      .map((id) => currentDocs.find((d) => d.id === id))
      .filter((d): d is ProjectDocument => Boolean(d))
      .map((d) => ({
        title: `${d.title} [id=${d.id}]${d.kind === 'table' ? '（表格）' : ''}`,
        content: d.content || '（空文档）',
      }));
    return buildSystemPrompt({
      snapshot,
      skills,
      docs: refs,
      todos: (liveChat?.todos ?? active?.todos ?? []).map((t) => ({ text: t.text, status: t.status })),
      web: agentCtx.web !== false,
      nativeTools: true,
      extra: cfg?.systemPrompt?.trim() || undefined,
    });
  }, [projectId, project?.name, update, rename, agentCtx, docs, activeId, active?.todos, cfg?.systemPrompt]);

  /** 当前提示词前缀大概占多少 token —— 让人看得见「输入有多重」 */
  const [prefixTokens, setPrefixTokens] = useState(0);
  useEffect(() => {
    if (tab !== 'context') return;
    let cancelled = false;
    void buildPrompt().then((p) => { if (!cancelled) setPrefixTokens(estimateTokens(p)); });
    return () => { cancelled = true; };
  }, [tab, buildPrompt]);

  /* ---------------- 工具箱 ---------------- */

  const actions: AgentActions = useMemo(
    () => createAgentActions({
      projectId,
      projectName: project?.name ?? '',
      update,
      rename,
      web: agentCtx.web !== false,
      webProvider: agentCtx.webProvider || 'auto',
      webApiKey: agentCtx.webApiKey || '',
      setTodos: (t: TodoItem[]) => updateChatTodos(activeId, t),
    }),
    [projectId, project?.name, update, rename, agentCtx.web, agentCtx.webProvider, agentCtx.webApiKey, activeId],
  );

  /* ---------------- 本地规则引擎（未启用模型时） ---------------- */

  function localRule(text: string): ToolCall[] | null {
    const t = text.trim();
    let m: RegExpMatchArray | null;
    if (/统计|概况|有多少|全貌|overview/i.test(t)) return [{ tool: 'project.overview', args: {} }];
    if (/^(列出|查看|有哪些)?牌组/.test(t)) return [{ tool: 'deck.list', args: {} }];
    if (/^(列出|查看)?字段/.test(t)) return [{ tool: 'field.list', args: {} }];
    if (/^(列出|查看)?文档/.test(t)) return [{ tool: 'doc.list', args: {} }];
    if (/^(列出|查看)?素材/.test(t)) return [{ tool: 'asset.list', args: {} }];
    if ((m = t.match(/(?:新建|新增|添加|加一张|加个).{0,3}卡牌\s*(.+)/))) return [{ tool: 'card.add', args: { name: m[1].trim() } }];
    if ((m = t.match(/(?:新建|新增|添加)字段\s*(\S+)/))) return [{ tool: 'field.add', args: { name: m[1] } }];
    if ((m = t.match(/(?:新建|新增|添加)牌组\s*(\S+)/))) return [{ tool: 'deck.create', args: { name: m[1] } }];
    if ((m = t.match(/(?:数量|张数|份数).{0,8}改成?\s*(\d+)/)) || (m = t.match(/把.{0,10}数量改成?\s*(\d+)/))) {
      return [{ tool: 'card.batchSet', args: { field: 'count', value: Number(m[1]) } }];
    }
    if ((m = t.match(/改名(?:为|成)?\s*(.+)/))) return [{ tool: 'project.rename', args: { name: m[1].trim() } }];
    return null;
  }

  /* ---------------- 危险操作确认 ---------------- */

  const askApprove = useCallback(
    (call: ToolCall) => new Promise<boolean | 'always'>((resolve) => setApproveReq({ call, resolve })),
    [],
  );

  /* ---------------- 发送 ---------------- */

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || runLock.current) return;
    if (!projectId) { toast('请先打开一个项目', 'err'); return; }
    const chat = active;
    if (!chat) { toast('还没有会话，先点左上角「+ 新会话」', 'err'); return; }
    if (!cfg) { toast('模型配置还在加载，稍等一下', 'info'); return; }

    runLock.current = true;
    setInput('');
    setMention(null);
    setBusy(true);
    const chatId = chat.id;

    let messageId: string | undefined;
    let storageError: Error | undefined;
    const records: ToolRecord[] = [];
    const journal = new Map<string, string>();
    const runApproved = new Set(agentCtx.approved ?? []);
    // A deliberate 'continue' resumes the latest unfinished run's additive-operation ledger.
    const previousRun = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.agentRun;
    if (/^(继续|接着|续跑)/.test(text) && previousRun && previousRun.status !== 'completed') {
      records.push(...previousRun.records);
      for (const record of previousRun.records) {
        if (record.status === 'success' || record.status === 'replayed') journal.set(callKey(record), record.content);
      }
    }
    let runStatus = 'running';

    // 串行写盘，避免流式节流时多个 patch 互相覆盖
    let chain: Promise<unknown> = Promise.resolve();
    let acc = '';
    let think = ''; // 思考模式下的推理过程，和正文分开存
    let lastFlush = 0;
    const write = (force = false) => {
      if (!messageId) return;
      const now = Date.now();
      if (!force && now - lastFlush < 150) return;
      lastFlush = now;
      const r = think;
      const content = acc;
      const run = { status: runStatus, records: records.map((x) => ({ ...x })) };
      chain = chain.then(() => patchLastMessage(chatId, content, r, messageId, run)).catch((error) => { storageError = error; });
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    /** 执行一批工具调用，并把「本次会话都允许」的授权写回会话 */
    let effectiveActions: AgentActions = actions;
    const run = async (calls: ToolCall[]): Promise<RunResult> => {
      const res = await runToolCalls(calls, effectiveActions, {
        approve: askApprove,
        approved: runApproved,
        signal: ctrl.signal,
        journal,
        onRecord: (record) => { records.push(record); write(true); },
      });
      const before = agentCtx.approved ?? [];
      if (res.approved.some((t) => !before.includes(t))) {
        await updateChatContext(chatId, { approved: res.approved });
      }
      return res;
    };

    try {
      await appendMessage(chatId, { role: 'user', content: text });
      messageId = await appendMessage(chatId, { role: 'assistant', content: '' });
      if (!messageId) throw new Error('会话已不存在，无法开始任务');
      if (!cfg.enabled) {
        // 规则模式：把固定指令映射到同一套工具上
        const calls = localRule(text);
        acc = calls
          ? (await run(calls)).text
          : '未启用模型时只能听懂固定指令。可以试试：新增一张卡牌 火焰箭 / 新建字段 稀有度 / 把数量改成 2 / 统计一下\n\n'
            + '也可以在「模型设置」里接入任意 OpenAI 兼容的大模型，之后就能自由对话并直接改工程了。';
        runStatus = 'completed';
        await write(true);
        await chain;
        return;
      }

      if (!cfg.baseUrl.trim()) {
        runStatus = 'blocked';
        acc = '⚠️ 还没填接口地址。打开「模型设置」，填写形如 https://api.deepseek.com/v1 的地址。';
        await write(true);
        await chain;
        return;
      }
      if (!cfg.model.trim()) {
        runStatus = 'blocked';
        acc = '⚠️ 还没填模型名。打开「模型设置」，点「拉取列表」或手动填写，例如 deepseek-chat。';
        await write(true);
        await chain;
        return;
      }

      const model = resolveLLMConfig(cfg, chat.modelOverride || cfg.model).model;
      const outputTokens = clampMaxTokens(model, cfg.maxTokens).value;
      // 拉取外部 MCP server 提供的工具（拉不到就静默退化为仅核心工具）
      const remote = await fetchRemoteTools(ctrl.signal);
      effectiveActions = { ...actions, ...buildMcpActions(remote.tools) };
      const result = await runAgent({
        userText: text,
        history: chat.messages.map((m) => ({ role: m.role, content: m.agentRun ? `${m.content}\n\n执行状态：${m.agentRun.status}\n${m.agentRun.records.map((r) => `${r.tool} ${r.status}: ${r.content}`).join('\n')}` : m.content })),
        system: buildPrompt,
        outputTokens,
        contextWindow: cfg.contextWindow || 65536,
        signal: ctrl.signal,
        complete: (messages, onDelta, onFinish) => chatStream({
          cfg, messages, model, signal: ctrl.signal, onDelta, onFinish,
          tools: buildToolDefinitions(remote.defs),
          onReasoning: (delta) => { think += delta; write(); },
        }),
        execute: run,
        onText: (value) => { acc = value; write(); },
      });
      runStatus = result.status;

      await write(true);
      await chain;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        runStatus = 'cancelled';
        acc = acc ? `${acc}\n\n（已停止生成）` : '（已停止生成）';
        await write(true);
        await chain;
      } else {
        runStatus = 'error';
        const m = err.message ?? '';
        const hint =
          /401|Unauthorized|invalid api key|incorrect api key/i.test(m)
            ? 'API Key 无效或没有权限（401）。打开「模型设置」检查密钥。'
            : /404|not found|does not exist|unknown model/i.test(m)
              ? '模型名不存在（404）。点「拉取列表」确认可用的模型名。'
              : /402|insufficient|quota|balance/i.test(m)
                ? '账户额度不足或欠费（402）。'
                : /Failed to fetch|NetworkError|CORS|网络不可达/i.test(m)
                  ? '浏览器连不上模型服务。若是跨域，请在「模型设置」勾选「经由本地后端转发」，并确认后端已启动。'
                  : m;
        const completed = records.filter((r) => r.status === 'success' || r.status === 'replayed');
        acc = [acc, `❌ ${hint}`, completed.length ? `已记录 ${completed.length} 个成功动作；请继续剩余任务，避免重复新增。` : ''].filter(Boolean).join('\n\n');
        await write(true);
        await chain;
        toast('助手执行失败', 'err');
      }
    } finally {
      abortRef.current = null;
      runLock.current = false;
      if (storageError) toast(`会话保存失败：${storageError.message}`, 'err');
      setApproveReq((req) => { req?.resolve(false); return null; });
      setBusy(false);
    }
  }, [input, busy, active, cfg, actions, buildPrompt, agentCtx.approved, askApprove, projectId, toast]);

  const stop = () => {
    abortRef.current?.abort();
    setApproveReq((req) => { req?.resolve(false); return null; });
  };

  /* ---------------- @ 提及 ---------------- */

  const mentionItems = useMemo(() => {
    const q = (mention?.q ?? '').toLowerCase();
    const ds = docs
      .filter((d) => !q || d.title.toLowerCase().includes(q))
      .map((d) => ({
        key: `doc:${d.id}`,
        icon: d.kind === 'table' ? '📊' : '📝',
        label: d.title,
        sub: d.kind === 'table' ? `表格 · ${d.table?.rows?.length ?? 0} 行` : '文档',
      }));
    const ss = allSkills(agentCtx.customSkills ?? [])
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
      .map((s) => ({ key: `skill:${s.key}`, icon: '📚', label: s.name, sub: s.desc || '知识包' }));
    return [...ds, ...ss].slice(0, 12);
  }, [mention?.q, docs, agentCtx.customSkills]);

  const onInputChange = (v: string) => {
    setInput(v);
    // 找到最后一个未闭合的 @（后面没有空白、也没有再出现 @）
    const at = v.lastIndexOf('@');
    if (at >= 0 && !/[\s@]/.test(v.slice(at + 1))) {
      setMention({ start: at, q: v.slice(at + 1) });
      setMentionIdx(0);
    } else {
      setMention(null);
    }
  };

  const pickMention = (item: { key: string; label: string }) => {
    if (!mention) return;
    const [kind, id] = item.key.split(':');
    if (kind === 'doc') {
      const d = docs.find((x) => x.id === id);
      if (d && !(agentCtx.docIds ?? []).includes(id)) {
        void setCtx({ docIds: [...(agentCtx.docIds ?? []), id] });
        toast(`已挂载文档「${d.title}」`, 'ok');
      }
    } else if (!(agentCtx.skills ?? []).includes(id)) {
      void setCtx({ skills: [...(agentCtx.skills ?? []), id] });
      toast('已挂载知识包', 'ok');
    }
    setInput(`${input.slice(0, mention.start)}@${item.label} ${input.slice(mention.start + 1 + mention.q.length)}`);
    setMention(null);
  };

  /* ---------------- 会话管理 ---------------- */

  const onNewChat = async () => {
    const s = await createChat(projectId, `会话 ${chatList.length + 1}`);
    setFreshChat(s);
    setActiveId(s.id);
    setInput('');
    setMention(null);
    toast(`已新建「${s.title}」，与之前的会话互不影响`);
  };

  const onDeleteChat = async (s: ChatSession) => {
    const ok = await ask({ title: '删除会话', text: `确定删除「${s.title}」？该会话的 ${s.messages.length} 条消息将不可恢复。`, danger: true });
    if (!ok) return;
    await deleteChat(s.id);
    if (activeId === s.id) setActiveId('');
    toast('已删除会话');
  };

  const onRenameChat = async (s: ChatSession) => {
    const name = window.prompt('会话名称', s.title);
    if (name?.trim()) await renameChat(s.id, name.trim());
  };

  const onClearChat = async () => {
    if (!active) return;
    const ok = await ask({ title: '清空消息', text: `清空「${active.title}」的全部消息？`, danger: true });
    if (ok) await clearChatMessages(active.id);
  };

  const toggleTodo = async (t: TodoItem) => {
    if (!active) return;
    const next = (active.todos ?? []).map((x) => (x.id === t.id
      ? { ...x, status: (x.status === 'done' ? 'pending' : 'done') as TodoItem['status'] }
      : x));
    await updateChatTodos(active.id, next);
  };

  const saveCfg = async (next: LLMConfig) => {
    setCfg(next);
    await setLLMConfig(projectId, next);
  };

  /** 开关思考模式：DeepSeek 这类要换模型名的会顺带切模型，并把输出上限抬一档 */
  const onToggleThinking = async (on: boolean) => {
    if (!cfg) return;
    if (busy) { toast('本次生成结束后可切换模式', 'info'); return; }
    const effective = { ...cfg, model: active?.modelOverride || cfg.model };
    if (thinkingState(effective).locked) { toast('该模型推理常开，可在模型设置调整强度或更换模型', 'info'); return; }
    const next = toggleThinking(effective, on);
    if (active?.modelOverride) await db.chats.update(active.id, { modelOverride: next.model });
    await saveCfg(active?.modelOverride ? { ...next, model: cfg.model } : next);
    toast(
      on
        ? `已开启思考模式（最大 Token 提到 ${next.maxTokens}，思考内容也占额度）`
        : '已关闭思考模式',
      'info',
    );
  };

  const currentThinking = cfg ? thinkingState(resolveLLMConfig(cfg, active?.modelOverride || cfg.model)) : undefined;
  const modelLabel = cfg?.enabled
    ? `${providerByKey(cfg.provider)?.label ?? cfg.provider} · ${resolveLLMConfig(cfg, active?.modelOverride || cfg.model).model || '未填模型'}`
    : '本地规则模式';

  const mountedDocs = (agentCtx.docIds ?? []).length;
  const mountedSkills = (agentCtx.skills ?? []).length;
  const todos = active?.todos ?? [];
  const doneTodos = todos.filter((t) => t.status === 'done').length;

  return (
    <div
      className="chat-win wide"
      style={winPos ? { left: winPos.x, top: winPos.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div
        className="hd"
        style={{ cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.parentElement!.getBoundingClientRect();
          winDrag.current = { active: true, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!winDrag.current.active) return;
          const nx = Math.min(Math.max(8, e.clientX - winDrag.current.dx), window.innerWidth - 200);
          const ny = Math.min(Math.max(8, e.clientY - winDrag.current.dy), window.innerHeight - 80);
          winDrag.current.moved = true;
          setWinPos({ x: nx, y: ny });
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          winDrag.current.active = false;
        }}
      >
        <span style={{ flex: 1, fontWeight: 600 }}>🤖 项目助手</span>
        <button className={`btn sm ${tab === 'chats' ? '' : 'ghost'}`} onClick={() => setTab('chats')}>会话</button>
        <button className={`btn sm ${tab === 'context' ? '' : 'ghost'}`} onClick={() => setTab('context')}>
          上下文{mountedDocs + mountedSkills ? `（${mountedDocs + mountedSkills}）` : ''}
        </button>
        <button className={`btn sm ${tab === 'config' ? '' : 'ghost'}`} onClick={() => setTab('config')}>模型设置</button>
        {cfg?.enabled && (
          <button
            className={`btn sm ${currentThinking?.on ? 'primary' : 'ghost'}`}
            disabled={busy || currentThinking?.locked}
            title={currentThinking?.locked ? '该模型推理常开，请调整推理强度或更换模型' : '切换模式，从下一次发送开始生效'}
            onClick={() => void onToggleThinking(currentThinking?.on !== true)}
          >
            🧠 {currentThinking?.label}
          </button>
        )}
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>

      <div className="chat-body">
        {tab === 'chats' ? (
          <>
            <div className="chat-sessions">
              <div className="row" style={{ padding: '8px 8px 6px' }}>
                <button className="btn sm primary" onClick={() => void onNewChat()}>+ 新会话</button>
              </div>
              <div className="list">
                {chatList.map((s) => (
                  <div
                    key={s.id}
                    className={`sess ${s.id === activeId ? 'active' : ''}`}
                    onClick={() => setActiveId(s.id)}
                  >
                    <div className="t">{s.title}</div>
                    <div className="m small faint">
                      {s.messages.length} 条 · {formatDate(s.updatedAt)}
                    </div>
                    <div className="ops" onClick={(e) => e.stopPropagation()}>
                      <button className="btn sm ghost" title="重命名" onClick={() => void onRenameChat(s)}>✎</button>
                      <button className="btn sm ghost" title="删除" onClick={() => void onDeleteChat(s)}>🗑</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="ft small faint">
                {modelLabel}
                {cfg?.enabled && <div style={{ marginTop: 4 }}>可直接改工程 · {TOOL_NAMES.length} 个工具</div>}
                <div style={{ marginTop: 4 }}>
                  {agentCtx.web === false ? '🚫 未联网' : '🌐 可联网'}
                  {mountedDocs ? ` · 📎${mountedDocs} 文档` : ''}
                  {mountedSkills ? ` · 📚${mountedSkills} 知识包` : ''}
                </div>
              </div>
            </div>

            <div className="chat-main">
              {cfg && !cfg.enabled && cfg.baseUrl.trim() !== '' && cfg.model.trim() !== '' && (
                <div className="small" style={{
                  padding: '8px 12px', lineHeight: 1.6,
                  background: 'var(--warn-bg, #fff7ed)', borderBottom: '1px solid var(--warn, #fb923c)',
                }}>
                  模型已配置但还没启用，现在仍是本地规则模式（听不懂自然语言）。
                  <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={() => void saveCfg({ ...cfg, enabled: true })}>立即启用</button>
                </div>
              )}

              <div className="ctx-bar">
                <span className="small faint">上下文：</span>
                <span className="small">
                  {agentCtx.web === false ? '🚫 未联网' : '🌐 联网'}
                  {' · 📎 '}{mountedDocs} 文档
                  {' · 📚 '}{mountedSkills} 知识包
                </span>
                <button className="btn sm ghost" onClick={() => setTab('context')}>管理</button>
                <span className="small faint" style={{ marginLeft: 'auto' }}>输入 @ 可临时挂载文档 / 知识包</span>
              </div>

              {todos.length > 0 && (
                <div className="todo-strip">
                  <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <b>☑️ 待办 {doneTodos}/{todos.length}</b>
                    <button className="btn sm ghost" onClick={() => void updateChatTodos(active!.id, [])}>清空</button>
                  </div>
                  {todos.map((t) => (
                    <div key={t.id} className="todo-item" onClick={() => void toggleTodo(t)} title="点击切换完成">
                      <span>{t.status === 'done' ? '✅' : t.status === 'in_progress' ? '⏳' : '⬜'}</span>
                      <span className={t.status === 'done' ? 'done' : ''}>{t.text}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="msgs" ref={boxRef}>
                {!active?.messages.length && (
                  <div className="msg sys">
                    试试这些：
                    {'\n'}· 新增一张卡牌 火焰箭，费用 3
                    {'\n'}· 把所有卡牌数量改成 2
                    {'\n'}· 在正面加一个显示名称的标题，居中加粗
                    {'\n'}· 查一下万智牌的稀有度规则，按它给这批卡定稀有度
                    {'\n'}· @规则说明书 按这份文档把所有卡牌补一遍
                    {cfg?.enabled
                      ? '\n\n（已接入模型，可以直接用自然语言改牌组、字段、卡牌、版式、表格文档）'
                      : '\n\n（当前是本地规则模式，去「模型设置」接入大模型后可自由对话）'}
                  </div>
                )}
                {active?.messages.map((m) => (
                  <div key={m.id} className={`msg ${m.role === 'user' ? 'me' : m.role === 'system' ? 'sys' : 'ai'}`}>
                    {m.reasoning ? <ThinkingBlock text={m.reasoning} streaming={busy} /> : null}
                    {m.content || (busy ? '…' : '')}
                    {!!m.agentRun?.records.length && (
                      <details className="small mt8">
                        <summary>执行记录（{m.agentRun.records.length}）</summary>
                        {m.agentRun.records.map((record, index) => (
                          <div key={index} style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{record.content}</div>
                        ))}
                      </details>
                    )}
                  </div>
                ))}
              </div>

              <div className="inp-wrap">
                {mention && mentionItems.length > 0 && (
                  <div className="mention-pop">
                    {mentionItems.map((it, i) => (
                      <div
                        key={it.key}
                        className={`mention-item ${i === mentionIdx ? 'on' : ''}`}
                        onMouseDown={(e) => { e.preventDefault(); pickMention(it); }}
                      >
                        <span>{it.icon}</span>
                        <span className="lb">{it.label}</span>
                        <span className="small faint">{it.sub}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="inp">
                  <textarea
                    ref={taRef}
                    className="input"
                    rows={1}
                    placeholder={cfg?.enabled ? '说点什么（@ 挂载文档，回车发送，Shift+Enter 换行）' : '规则模式：新增一张卡牌 XXX / 统计一下'}
                    value={input}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (mention && mentionItems.length) {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionItems.length); return; }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length); return; }
                        if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          pickMention(mentionItems[Math.min(mentionIdx, mentionItems.length - 1)]);
                          return;
                        }
                        if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
                      }
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                    }}
                  />
                  {busy
                    ? <button className="btn" onClick={stop}>停止</button>
                    : <button className="btn primary" onClick={() => void send()} disabled={!input.trim()}>发送</button>}
                  <button className="btn ghost sm" title="清空当前会话消息" onClick={() => void onClearChat()}>清空</button>
                </div>
              </div>
            </div>
          </>
        ) : tab === 'context' ? (
          <ContextPanel
            ctx={agentCtx}
            docs={docs}
            prefixTokens={prefixTokens}
            onChange={(p) => void setCtx(p)}
            onBack={() => setTab('chats')}
          />
        ) : (
          <LLMConfigPanel
            cfg={cfg}
            modelOverride={active?.modelOverride}
            onClearModelOverride={() => { if (active) void db.chats.update(active.id, { modelOverride: '' }); }}
            onChange={(c) => void saveCfg(c)}
            onToggleThinking={(on) => void onToggleThinking(on)}
            onBack={() => setTab('chats')}
          />
        )}
      </div>

      {confirmNode}

      {approveReq && (
        <Modal
          title="⚠️ 确认危险操作"
          onClose={() => { approveReq.resolve(false); setApproveReq(null); }}
          footer={
            <>
              <button className="btn" onClick={() => { approveReq.resolve(false); setApproveReq(null); }}>拒绝</button>
              <button className="btn" onClick={() => { approveReq.resolve(true); setApproveReq(null); }}>允许一次</button>
              <button className="btn primary" onClick={() => { approveReq.resolve('always'); setApproveReq(null); }}>本次会话都允许</button>
            </>
          }
        >
          <div style={{ lineHeight: 1.8 }}>
            助手想要执行一次<strong>删除类</strong>操作：
            <div className="mono small" style={{ margin: '8px 0', padding: 8, background: 'var(--panel-2)', borderRadius: 6 }}>
              {describeCall(approveReq.call)}
            </div>
            <div className="small faint">参数：{JSON.stringify(approveReq.call.args ?? {})}</div>
            <div className="small faint" style={{ marginTop: 8 }}>
              选「本次会话都允许」后，{approveReq.call.tool} 在本次会话里不再弹窗（可在「上下文」页撤销）。
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- 上下文面板 ---------------- */

function ContextPanel({
  ctx, docs, prefixTokens, onChange, onBack,
}: {
  ctx: AgentContext;
  docs: ProjectDocument[];
  prefixTokens: number;
  onChange: (patch: Partial<AgentContext>) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<SkillDef | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const skills = allSkills(ctx.customSkills ?? []);
  const on = (k: string) => (ctx.skills ?? []).includes(k);
  const docOn = (id: string) => (ctx.docIds ?? []).includes(id);

  const toggleSkill = (k: string) => {
    const cur = ctx.skills ?? [];
    onChange({ skills: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] });
  };
  const toggleDoc = (id: string) => {
    const cur = ctx.docIds ?? [];
    onChange({ docIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  const saveSkill = () => {
    if (!draft) return;
    const key = draft.key.trim() || `custom-${Date.now()}`;
    const one: SkillDef = { ...draft, key, name: draft.name.trim() || key, builtin: false };
    const rest = (ctx.customSkills ?? []).filter((s) => s.key !== key);
    onChange({ customSkills: [...rest, one], skills: [...new Set([...(ctx.skills ?? []), key])] });
    setDraft(null);
    setEditing(null);
    toast('已保存知识包', 'ok');
  };

  const removeSkill = (key: string) => {
    onChange({
      customSkills: (ctx.customSkills ?? []).filter((s) => s.key !== key),
      skills: (ctx.skills ?? []).filter((s) => s !== key),
    });
  };

  const provider = WEB_PROVIDERS.find((p) => p.key === (ctx.webProvider || 'auto')) ?? WEB_PROVIDERS[0];

  return (
    <div className="chat-main cfg-panel">
      <div style={{ padding: 14, overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>🧩 上下文（拼进提示词前缀的内容）</b>
          <button className="btn sm ghost" onClick={onBack}>返回会话</button>
        </div>
        <div className="small faint mt8" style={{ lineHeight: 1.7 }}>
          勾选的内容会作为「参考资料」插进系统提示词：知识包是<strong>做事方法</strong>，文档是<strong>素材内容</strong>。
          多挂载会占用上下文长度，只挂当前任务需要的即可。
        </div>

        <div className="small mt8" style={{
          padding: '8px 10px', borderRadius: 8, lineHeight: 1.7,
          background: 'var(--panel-2)', border: '1px solid var(--border)',
        }}>
          当前提示词前缀约 <b>{prefixTokens.toLocaleString()}</b> tokens（工程快照 + 勾选的参考资料 + 工具说明书，每轮请求都会重发一遍）。
          <br />
          <span className="faint">
            这是<strong>输入</strong>，跟「最大 Token」（单次<strong>输出</strong>上限）是两回事；
            但输入越重，模型可用的思考空间越小，多轮对话里也更容易提前收尾。
          </span>
        </div>

        {/* 联网 */}
        <div className="ctx-block">
          <div className="ctx-hd">🌐 联网</div>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={ctx.web !== false} onChange={(e) => onChange({ web: e.target.checked })} />
            允许助手调用 web.search / web.fetch（经由本地后端，绕开浏览器跨域）
          </label>
          {ctx.web !== false && (
            <div className="row mt8" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label className="lbl">搜索引擎</label>
                <select className="input" value={provider.key} onChange={(e) => onChange({ webProvider: e.target.value })}>
                  {WEB_PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              {provider.needKey && (
                <div className="field" style={{ flex: '1 1 220px' }}>
                  <label className="lbl">API Key</label>
                  <input
                    className="input mono"
                    type="password"
                    value={ctx.webApiKey ?? ''}
                    placeholder="该通道的密钥"
                    onChange={(e) => onChange({ webApiKey: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}
          <div className="small faint mt8">
            不填 Key 也能用：默认走 DuckDuckGo，失败自动退回维基百科。抓正文用 web.fetch，模型会自动去噪并截断。
          </div>
        </div>

        {/* 文档 */}
        <div className="ctx-block">
          <div className="ctx-hd">📎 项目文档（{docs.length}）</div>
          {docs.length === 0 && <div className="small faint">还没有文档。去「文档」页新建，或上传 xlsx / csv / md。</div>}
          <div className="ctx-list">
            {docs.map((d) => (
              <label key={d.id} className={`ctx-item ${docOn(d.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={docOn(d.id)} onChange={() => toggleDoc(d.id)} />
                <span>{d.kind === 'table' ? '📊' : '📝'}</span>
                <span className="lb">{d.title}</span>
                <span className="small faint">
                  {d.kind === 'table'
                    ? `${d.table?.header?.length ?? 0} 列 × ${d.table?.rows?.length ?? 0} 行`
                    : `${(d.content ?? '').length} 字`}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 知识包 */}
        <div className="ctx-block">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="ctx-hd">📚 知识包</div>
            <button className="btn sm" onClick={() => { setDraft({ key: '', name: '', desc: '', body: '' }); setEditing(null); }}>+ 新建</button>
          </div>
          <div className="ctx-list">
            {skills.map((s) => (
              <div key={s.key} className={`ctx-item ${on(s.key) ? 'on' : ''}`}>
                <input type="checkbox" checked={on(s.key)} onChange={() => toggleSkill(s.key)} />
                <span>📚</span>
                <div className="lb" style={{ flex: 1, minWidth: 0 }}>
                  <div>{s.name}</div>
                  <div className="small faint">{s.desc}</div>
                </div>
                <span className="small faint">{s.builtin ? '内置' : '自定义'}</span>
                {!s.builtin && (
                  <>
                    <button className="btn sm ghost" onClick={() => { setDraft({ ...s }); setEditing(s.key); }}>✎</button>
                    <button className="btn sm ghost" onClick={() => removeSkill(s.key)}>🗑</button>
                  </>
                )}
              </div>
            ))}
          </div>

          {draft && (
            <div className="skill-editor">
              <div className="row mt8" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div className="field" style={{ flex: '1 1 160px' }}>
                  <label className="lbl">名称</label>
                  <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </div>
                <div className="field" style={{ flex: '1 1 160px' }}>
                  <label className="lbl">标识（英文/短名）</label>
                  <input className="input mono" value={draft.key} placeholder="my-rules" onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
                </div>
                <div className="field" style={{ flex: '1 1 240px' }}>
                  <label className="lbl">一句话说明</label>
                  <input className="input" value={draft.desc} onChange={(e) => setDraft({ ...draft, desc: e.target.value })} />
                </div>
              </div>
              <div className="field mt8">
                <label className="lbl">正文（会原样拼进提示词前缀）</label>
                <textarea
                  className="input"
                  rows={8}
                  value={draft.body}
                  placeholder={'## 我的规则\n- 所有卡牌默认数量 3\n- 稀有度只有 普通/稀有/传说 三档'}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </div>
              <div className="row mt8">
                <button className="btn primary" onClick={saveSkill}>{editing ? '保存修改' : '创建并挂载'}</button>
                <button className="btn ghost" onClick={() => { setDraft(null); setEditing(null); }}>取消</button>
              </div>
            </div>
          )}
        </div>

        {/* 授权 */}
        <div className="ctx-block">
          <div className="ctx-hd">🔓 已放行的危险操作</div>
          {(ctx.approved ?? []).length === 0
            ? <div className="small faint">暂无。删除类工具首次调用时会弹窗确认。</div>
            : (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {(ctx.approved ?? []).map((t) => (
                  <span key={t} className="chip">
                    {t}
                    <button className="btn sm ghost" onClick={() => onChange({ approved: (ctx.approved ?? []).filter((x) => x !== t) })}>✕</button>
                  </span>
                ))}
                <button className="btn sm ghost" onClick={() => onChange({ approved: [] })}>全部撤销</button>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 思考模式 ---------------- */

/**
 * 切换思考开关时顺带做的两件事：
 *   1. DeepSeek 这类靠换模型名的，把模型名切过去 / 切回来；
 *   2. 思考链和正文共用 max_tokens 额度，开的时候抬一档，免得一开就被截断。
 */
export function toggleThinking(cfg: LLMConfig, on: boolean): LLMConfig {
  const next = applyThinkingToggle(cfg, on);
  // 思维链和正文共用 max_tokens：DeepSeek 光思维链就能吃掉 32K，给足一点
  const target = thinkingSpecOf(cfg).kind === 'model' ? 16384 : 8192;
  if (on && next.maxTokens < target) return { ...next, maxTokens: target };
  return next;
}

const THINKING_KIND_LABEL: Record<string, string> = {
  model: '换模型名',
  reasoning_effort: 'reasoning_effort',
  enable_thinking: 'enable_thinking',
  thinking_object: 'thinking:{type}',
  budget: 'thinking:budget_tokens',
  template: 'chat_template_kwargs',
};

/** 思考过程默认折叠，只露出最后一句，长回复时不至于把正文挤没了 */
function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="think-block">
      <button className="think-hd" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'}</span>
        <span>思考过程</span>
        <span className="small faint">
          {streaming ? '进行中…' : `约 ${estimateTokens(text)} tokens`}
        </span>
      </button>
      {open
        ? <div className="think-body">{text}</div>
        : <div className="think-peek">{text.slice(-80)}</div>}
    </div>
  );
}

/* ---------------- 模型设置面板 ---------------- */

/**
 * 最大 Token 的实时换算提示。
 * 经验值：中文约 0.6~0.7 字/token（各家分词器略有差异），英文约 0.75 词/token。
 */
function maxTokenHint(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '请填一个正数';
  const cn = `${Math.round(n * 0.6)}~${Math.round(n * 0.7)} 个中文字`;
  const en = `${Math.round(n * 0.75)} 个英文词`;
  const size = `约 ${cn}（或 ${en}）`;
  if (n < 1500) return `${size} —— 偏小，工具调用的 JSON 经常被截断，工程可能改不动`;
  if (n < 3000) return `${size} —— 简单问答够用，批量改牌建议调大`;
  if (n < 8000) return `${size} —— 推荐区间，成功率和成本比较平衡`;
  return `${size} —— 适合大表格 / 批量任务，注意别超过厂商自己的上限`;
}

function LLMConfigPanel({
  cfg, modelOverride, onClearModelOverride, onChange, onToggleThinking, onBack,
}: {
  cfg: LLMConfig | null;
  onChange: (c: LLMConfig) => void;
  modelOverride?: string;
  onClearModelOverride?: () => void;
  onToggleThinking: (on: boolean) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  if (!cfg) return <div className="chat-main"><div className="muted small" style={{ padding: 16 }}>加载中…</div></div>;

  const preset = providerByKey(cfg.provider);
  const patch = (p: Partial<LLMConfig>) => onChange({ ...cfg, ...p });

  // 思考模式：不同厂商字段不同，统一在这里翻译成对应的请求参数
  const effective = resolveLLMConfig(cfg, modelOverride || cfg.model);
  const spec = thinkingSpecOf(effective);
  const mode = thinkingState(effective);
  const thinkOn = mode.on === true;
  // 超过模型自身输出上限会被厂商 400，这里提前夹住并提示
  const cap = clampMaxTokens(effective.model, cfg.maxTokens);

  // 必填项是否齐了（有些本地服务不需要 key，所以 key 只提示不拦截）
  const ready = Boolean(cfg.baseUrl.trim() && cfg.model.trim());
  const missingKey = !cfg.apiKey.trim() && cfg.provider !== 'ollama' && cfg.provider !== 'custom';

  const onPickProvider = (key: string) => {
    const p = providerByKey(key);
    patch({
      provider: key,
      baseUrl: p?.baseUrl ?? cfg.baseUrl,
      model: p?.models[0] ?? cfg.model,
      // 厂商不允许直连时自动切到后端代理
      useProxy: p?.corsOk === true ? false : true,
    });
    setResult(null);
    setModels([]);
  };

  const onTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await testConnection(cfg);
      setResult({ ok: r.ok, msg: r.msg });
      if (r.models?.length) setModels(r.models);
      // 连通就顺手启用，省得用户配好了却用不上
      if (r.ok && !cfg.enabled) {
        onChange({ ...cfg, enabled: true });
        toast('已自动启用该模型', 'ok');
      }
    } finally {
      setTesting(false);
    }
  };

  const onFetchModels = async () => {
    setLoadingModels(true);
    try {
      const list = await fetchModels(cfg);
      if (!list.length) {
        toast('没拉到模型列表，可手动填写模型名', 'info');
      } else {
        setModels(list);
        if (!cfg.model.trim()) patch({ model: list[0] });
      }
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="chat-main cfg-panel">
      <div style={{ padding: 14, overflow: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            启用大模型（关闭则使用本地规则引擎，不联网）
          </label>
          <button className="btn sm ghost" onClick={onBack}>返回会话</button>
        </div>

        {!cfg.enabled && ready && (
          <div className="small mt8" style={{
            padding: '8px 10px', borderRadius: 8,
            background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn, #fb923c)',
          }}>
            配置已填好，但还没启用 —— 现在助手仍走本地规则模式。
            <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={() => patch({ enabled: true })}>立即启用</button>
          </div>
        )}
        {cfg.enabled && !ready && (
          <div className="small danger mt8">接口地址或模型名还没填，助手无法调用模型。</div>
        )}
        {cfg.enabled && ready && missingKey && (
          <div className="small faint mt8">提示：还没填 API Key，多数厂商会返回 401。</div>
        )}

        <div className="field mt8">
          <label className="lbl">厂商</label>
          <select className="input" value={cfg.provider} onChange={(e) => onPickProvider(e.target.value)}>
            {LLM_PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {preset?.hint && <div className="small faint mt8">{preset.hint}</div>}
        </div>

        <div className="field mt8">
          <label className="lbl">接口地址（OpenAI 兼容，不要带 /chat/completions）</label>
          <input className="input mono" value={cfg.baseUrl} placeholder="https://api.deepseek.com/v1" onChange={(e) => patch({ baseUrl: e.target.value })} />
        </div>

        <div className="field mt8">
          <label className="lbl">模型</label>
          <div className="row">
            <input className="input mono" list="llm-model-options" value={cfg.model} placeholder="deepseek-chat" onChange={(e) => patch({ model: e.target.value })} />
            <button className="btn sm" disabled={loadingModels} onClick={() => void onFetchModels()}>
              {loadingModels ? '拉取中…' : '拉取列表'}
            </button>
          </div>
          <datalist id="llm-model-options">
            {(models.length ? models : (preset?.models ?? [])).map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>

        <div className="field mt8">
          <label className="lbl">API Key</label>
          <div className="row">
            <input
              className="input mono"
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              placeholder="sk-…（Ollama 等本地服务可留空）"
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            <button className="btn sm ghost" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
          </div>
          <div className="small faint mt8">密钥只保存在本机浏览器，不写进项目文档，也不会同步到服务端。</div>
        </div>

        <div className="row mt8" style={{ gap: 14, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label className="lbl">温度 {cfg.temperature}</label>
            <input type="range" min={0} max={1} step={0.05} value={cfg.temperature} onChange={(e) => patch({ temperature: Number(e.target.value) })} />
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label className="lbl">最大 Token（单次回复上限）</label>
            <input className="input" type="number" min={256} max={32768} step={256} value={cfg.maxTokens} onChange={(e) => patch({ maxTokens: Number(e.target.value) })} />
            <div className="small faint mt8">{maxTokenHint(cfg.maxTokens)}</div>
            {cap.capped && (
              <div className="small mt8" style={{ color: 'var(--warn, #fb923c)' }}>
                该模型自身输出上限是 {cap.value}，实际请求会按 {cap.value} 发送（填再大也会被厂商拒绝）。
              </div>
            )}
          </div>
        </div>
        <div className="row mt8" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="small faint">快捷：</span>
          {[2048, 4096, 8192, 16384].map((n) => (
            <button key={n} className={`btn sm ${cfg.maxTokens === n ? '' : 'ghost'}`} onClick={() => patch({ maxTokens: n })}>{n}</button>
          ))}
        </div>

        <div className="field mt8">
          <label className="lbl">上下文窗口（输入与输出总容量）</label>
          <input className="input" type="number" min={8192} max={2097152} step={1024}
            value={cfg.contextWindow || 65536} onChange={(e) => patch({ contextWindow: Math.max(8192, Number(e.target.value) || 65536) })} />
          <div className="small faint mt8">按模型实际容量填写，默认 65536。优先保留本次任务和工具结果，超出预算时明确提示。</div>
        </div>

        {modelOverride && <div className="small mt8">当前会话指定模型：{effective.model} <button className="btn sm ghost" onClick={onClearModelOverride}>改为跟随项目配置</button></div>}

        {/* 思考模式：各家字段名不统一，这里只暴露开关，具体参数由 thinkingSpecOf 翻译 */}
        <div className="field mt8 think-cfg">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={thinkOn} disabled={mode.locked} onChange={(e) => onToggleThinking(e.target.checked)} />
              <b>🧠 {mode.label}</b>
            </label>
            <span className="small faint mono">{THINKING_KIND_LABEL[spec.kind] ?? spec.kind}</span>
          </div>

          {spec.kind === 'model' && spec.model && (
            <div className="small faint mt8">
              开启后模型名自动切成 <span className="mono">{spec.model}</span>，关闭时切回{' '}
              <span className="mono">{cfg.thinkingBaseModel || spec.baseModel || '原模型'}</span>。
            </div>
          )}

          {(spec.kind === 'reasoning_effort' || spec.kind === 'budget') && !!spec.efforts?.length && (
            <div className="row mt8" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="small faint">{spec.kind === 'budget' ? '思考预算：' : '推理强度：'}</span>
              {spec.efforts.map((v) => {
                const cur = spec.kind === 'budget'
                  ? String(cfg.thinkingBudget ?? cfg.thinkingEffort ?? '4096')
                  : (cfg.thinkingEffort || 'medium');
                return (
                  <button
                    key={v}
                    className={`btn sm ${cur === v ? '' : 'ghost'}`}
                    onClick={() => patch(spec.kind === 'budget'
                      ? { thinkingBudget: Number(v) }
                      : { thinkingEffort: v })}
                  >{v}</button>
                );
              })}
              {!thinkOn && <span className="small faint">（要先开启思考才会发出去）</span>}
            </div>
          )}

          {cfg.provider === 'custom' && (
            <div className="field mt8">
              <label className="lbl">思考参数形式</label>
              <select
                className="input"
                value={cfg.thinkingKind ?? 'auto'}
                onChange={(e) => patch({
                  thinkingKind: e.target.value === 'auto' ? undefined : (e.target.value as LLMConfig['thinkingKind']),
                })}
              >
                <option value="auto">自动（按模型名判断）</option>
                <option value="enable_thinking">enable_thinking（Qwen3 / 多数网关）</option>
                <option value="thinking_object">thinking: {'{type}'}（智谱 GLM）</option>
                <option value="reasoning_effort">reasoning_effort（OpenAI o 系列）</option>
                <option value="budget">thinking: {'{budget_tokens}'}（Claude / OpenRouter）</option>
                <option value="template">chat_template_kwargs（vLLM / Ollama）</option>
                <option value="model">换模型名（DeepSeek）</option>
              </select>
            </div>
          )}

          {thinkOn && (
            <div className="small mt8" style={{
              padding: '8px 10px', borderRadius: 8,
              background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn, #fb923c)',
            }}>
              思考内容（思维链）和正文共用「最大 Token」额度，实际发出 {cap.value}。
              DeepSeek 的思维链最多能到 32K，配额被它先吃光的话，正文和工具 JSON 就会被截断 ——
              建议 16384 以上，并且别同时让它改太多东西。
            </div>
          )}
          {spec.hint && <div className="small faint mt8">{spec.hint}</div>}
        </div>

        <div className="field mt8">
          <label className="lbl">附加提示词（会拼在内置工具说明之后，可留空）</label>
          <textarea
            className="input"
            rows={3}
            value={cfg.systemPrompt ?? ''}
            placeholder="例如：所有卡牌默认数量 3；回答只用中文，不超过 3 句"
            onChange={(e) => patch({ systemPrompt: e.target.value })}
          />
        </div>

        <label className="row small mt8" style={{ gap: 6 }}>
          <input type="checkbox" checked={cfg.useProxy} onChange={(e) => patch({ useProxy: e.target.checked })} />
          经由本地后端转发（推荐：规避跨域，密钥只在本机后端流转）
        </label>

        <div className="row mt8">
          <button className="btn primary" disabled={testing || !ready} onClick={() => void onTest()}>
            {testing ? '测试中…' : '测试连通性'}
          </button>
          <button className="btn ghost" onClick={() => patch({ systemPrompt: '' })}>清空附加提示词</button>
          <button className="btn ghost" onClick={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>示例提示词</button>
        </div>

        {result && (
          <div className={`small mt8 ${result.ok ? '' : 'danger'}`} style={{ color: result.ok ? 'var(--ok, #16a34a)' : 'var(--danger, #dc2626)' }}>
            {result.ok ? '✅ ' : '❌ '}{result.msg}
          </div>
        )}

        <div className="small faint mt8" style={{ lineHeight: 1.8 }}>
          兼容任何 OpenAI 格式的 <span className="mono">/chat/completions</span> 接口：
          OpenAI、DeepSeek、通义千问、Kimi、智谱 GLM、硅基流动、火山方舟、OpenRouter、
          Ollama、One-API / New API 等自建网关。
          直连失败时一般就是跨域限制，勾上「经由本地后端转发」即可（需后端在跑）。
          <br />
          启用后助手可以调用 {TOOL_NAMES.length} 个工具直接改牌组 / 字段 / 卡牌 / 版式 / 文档 / 表格 / 素材 / 导出设置，
          还能联网查资料（在「上下文」页开启）。
        </div>
      </div>
    </div>
  );
}
