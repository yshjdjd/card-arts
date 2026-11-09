import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(file, plugins = []) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': '{}' }, plugins });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const S = await load('./src/lib/agentStream.ts');
const P = await load('./src/lib/agentProtocol.ts');
const C = await load('./src/lib/agentContext.ts');
const R = await load('./src/lib/agentRuntime.ts');
const D = await load('./src/lib/agentData.ts');
const L = await load('./src/lib/llm.ts');
const actions = await load('./src/lib/agentTools.ts', [{ name: 'memory-db', setup(build) {
  build.onResolve({ filter: /db\/schema$/ }, () => ({ path: 'db', namespace: 'memory' }));
  build.onLoad({ filter: /.*/, namespace: 'memory' }, () => ({ contents: `export const db = { projects: { get: async () => globalThis.testProject } }; export const uid = () => 'new-id'; export const emptyLayout = () => ({}); export const defaultFields = () => [];` }));
} }]);
const json = (calls) => '```json\n' + JSON.stringify({ actions: calls }) + '\n```';
const add = { tool: 'card.add', args: { name: 'A' } };
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (content, finish_reason) => event({ choices: [{ delta: { content }, finish_reason }] });
const stream = (value, step = 3) => {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step)); controller.close(); } });
};
const config = { ...L.defaultLLMConfig(), enabled: true, model: 'fake', baseUrl: 'https://fake.invalid/v1', useProxy: true };

test('SSE preserves Chinese byte fragments, reasoning, finish reason and final line without newline', async () => {
  let text = '', reasoning = '', reason = '';
  const wire = event({ choices: [{ delta: { reasoning_content: '思考' } }] }) + chunk('你好😀', 'stop') + 'data: [DONE]';
  assert.equal((await S.readSSE(stream(wire, 1), (d) => text += d, undefined, (r) => reason = r, (d) => reasoning += d)).content, '你好😀');
  assert.equal(text, '你好😀'); assert.equal(reasoning, '思考'); assert.equal(reason, 'stop');
});
test('SSE handles multiline data events and CRLF', async () => {
  const wire = 'data: {"choices":\r\ndata: [{"delta":{"content":"OK"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  assert.equal((await S.readSSE(stream(wire, 1))).content, 'OK');
});
test('SSE exposes upstream errors after partial text rather than accepting it', async () => {
  await assert.rejects(S.readSSE(stream(chunk('一半') + event({ error: { message: 'upstream timeout' } }) + 'data: [DONE]\n\n')), (e) => e.partial === '一半' && /timeout/.test(e.message));
});
test('SSE rejects clean EOF without finish signal, malformed data, and premature network errors', async () => {
  await assert.rejects(S.readSSE(stream(chunk('half'))), /提前结束/);
  await assert.rejects(S.readSSE(stream('data: {oops}\n\n')), /无法解析/);
  const broken = new ReadableStream({ start(c) { c.error(new Error('socket reset')); } });
  await assert.rejects(S.readSSE(broken), /socket reset/);
});
test('SSE abort releases a blocked reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = S.readSSE(body, undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
test('SSE accumulates fragmented tool_calls (id, name and arguments arriving in separate chunks)', async () => {
  const tc = (tcDelta, finish_reason) => event({ choices: [{ delta: { tool_calls: [tcDelta] }, finish_reason }] });
  const wire = tc({ index: 0, id: 'call_0', type: 'function', function: { name: 'card.add', arguments: '' } })
    + tc({ index: 0, function: { arguments: '{"a":' } })
    + tc({ index: 0, function: { arguments: '1}' } })
    + tc({}, 'tool_calls') + 'data: [DONE]';
  const r = await S.readSSE(stream(wire, 1));
  assert.equal(r.toolCalls.length, 1);
  assert.deepEqual(r.toolCalls[0], { index: 0, id: 'call_0', name: 'card.add', arguments: '{"a":1}' });
  assert.equal(r.content, '');
});
test('transport does not retry an errored stream or a thinking-only length completion', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return new Response(stream(chunk('half') + event({ error: 'timeout' })), { headers: { 'content-type': 'text/event-stream' } }); };
    await assert.rejects(L.chatStream({ cfg: config, messages: [] }), /timeout/);
    assert.equal(requests, 1);
    let reason = '';
    globalThis.fetch = async () => { requests++; return new Response(stream(chunk('', 'length')), { headers: { 'content-type': 'text/event-stream' } }); };
    assert.equal((await L.chatStream({ cfg: config, messages: [], onFinish: (r) => reason = r })).content, '');
    assert.equal(reason, 'length'); assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});
test('JSON stream fallback consumes the response once and non-streaming proxy preserves o-series token limit and abort signal', async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  let seen;
  try {
    globalThis.fetch = async (url, init) => {
      seen = init;
      return Response.json({ content: 'OK', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], finish_reason: 'stop' });
    };
    assert.equal((await L.chatStream({ cfg: config, messages: [] })).content, 'OK');
    await L.chatComplete({ cfg: { ...config, model: 'o4-mini', outputMode: 'manual', maxTokens: 8192 }, messages: [], signal });
    assert.equal(JSON.parse(seen.body).max_completion_tokens, 8192);
    assert.equal(seen.signal, signal);
  } finally { globalThis.fetch = original; }
});
test('DeepSeek V4 toggle changes actual request parameters for proxy and direct channels', async () => {
  const original = globalThis.fetch;
  try {
    for (const useProxy of [true, false]) {
      for (const thinking of [true, false]) {
        let request;
        globalThis.fetch = async (_, init) => { request = JSON.parse(init.body); return new Response(stream(chunk('OK', 'stop')), { headers: { 'content-type': 'text/event-stream' } }); };
        const cfg = { ...config, provider: 'deepseek', model: 'deepseek-v4-pro', useProxy, thinking };
        await L.chatStream({ cfg, messages: [] });
        assert.equal(request.model, 'deepseek-v4-pro');
        assert.equal((useProxy ? request.extra : request).thinking.type, thinking ? 'enabled' : 'disabled');
        assert.equal(L.thinkingState(cfg).on, thinking);
      }
    }
  } finally { globalThis.fetch = original; }
});
test('legacy reasoning aliases and per-chat overrides follow the explicit preference at request time', async () => {
  const original = globalThis.fetch;
  try {
    let request;
    globalThis.fetch = async (_, init) => { request = JSON.parse(init.body); return new Response(stream(chunk('OK', 'stop'))); };
    await L.chatStream({ cfg: { ...config, provider: 'custom', model: 'deepseek-reasoner', thinking: false }, model: 'deepseek-reasoner', messages: [] });
    assert.equal(request.model, 'deepseek-chat');
    assert.equal(L.thinkingState(L.resolveLLMConfig({ ...config, model: 'deepseek-reasoner', thinking: false })).on, false);
    assert.equal(L.thinkingState({ ...config, model: 'unknown', thinking: undefined }).label, '跟随模型默认');
    assert.equal(L.thinkingState({ ...config, model: 'o4-mini', thinking: false }).locked, true);
  } finally { globalThis.fetch = original; }
});
test('context budget keeps full current task, discards whole old turns, counts JSON punctuation', () => {
  const history = [{ role: 'user', content: 'x'.repeat(3000) }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'recent' }, { role: 'assistant', content: 'reply' }];
  const current = [{ role: 'user', content: 'original task' }, { role: 'assistant', content: json([add]) }, { role: 'user', content: 'new id 123' }];
  const selected = C.selectContext('rules', history, current, 2200, 500);
  assert.equal(selected.dropped, 2);
  assert.deepEqual(selected.messages.slice(-3), current);
  assert.equal(selected.messages[1].content, 'recent');
  assert.ok(C.contextTokens('{}[]'.repeat(100)) >= 200);
  assert.throws(() => C.selectContext('中'.repeat(3000), [], current, 2200, 500), /预算不足/);
});
test('runtime retains docs, tool schemas and all intermediate results beyond four rounds', async () => {
  let calls = 0, displayed = '';
  const result = await R.runAgent({ userText: '任务', history: [], outputTokens: 4096, system: async () => '规则、资料、参数',
    complete: async (messages, delta, finish) => {
      assert.equal(messages[0].content, '规则、资料、参数');
      for (let n = 0; n < calls; n++) assert.ok(messages.some((m) => m.content.includes(`RESULT_${n}`)));
      const reply = calls < 5 ? json([{ tool: 'deck.list', args: { n: calls } }]) : '全部完成';
      calls++; delta(reply); finish('stop'); return { content: reply, toolCalls: [] };
    }, execute: async () => ({ text: `RESULT_${calls - 1}`, records: [], approved: [] }), onText: (value) => displayed = value,
  });
  assert.equal(result.status, 'completed'); assert.equal(result.rounds, 6);
  assert.ok(displayed.endsWith('全部完成')); assert.ok(!displayed.includes('```'));
});
test('truncated reply keeps complete prefix actions and auto-continues instead of discarding the round', async () => {
  let executed = 0, rounds = 0;
  const truncated = '好的，开始。\n```json\n'
    + JSON.stringify({ actions: [{ tool: 'card.add', args: { name: 'A' } }] }) + '\n```\n'
    + '```json\n{"actions":[{"tool":"card.set","args":{"value":1}},{"tool":"card.set","ar';
  const result = await R.runAgent({ userText: 'task', history: [], outputTokens: 8192, system: async () => '',
    complete: async (_, delta, finish) => {
      rounds++;
      if (rounds === 1) { delta(truncated); finish('length'); return { content: truncated, toolCalls: [] }; }
      finish('stop'); delta('剩余已完成'); return { content: '剩余已完成', toolCalls: [] };
    },
    execute: async (calls) => {
      executed += calls.length;
      return { text: 'ok', records: calls.map((c) => ({ ...c, status: 'success', content: 'ok' })), approved: [] };
    },
    onText: () => {},
  });
  assert.equal(executed, 2, '闭合块 1 个 + 半截块里写完的 1 个都被抢救执行');
  assert.equal(rounds, 2, '抢救后自动续跑，不等用户说继续');
  assert.equal(result.status, 'completed');
});
test('truncated reply with zero complete actions still executes nothing', async () => {
  for (const reason of ['length', '']) {
    let executed = 0;
    const result = await R.runAgent({ userText: 'task', history: [], outputTokens: 8192, system: async () => '',
      complete: async (_, delta, finish) => { const t = '```json\n{"actions":['; delta(t); finish(reason); return { content: t, toolCalls: [] }; },
      execute: async () => { executed++; throw new Error('must not execute'); }, onText: () => {},
    });
    assert.equal(executed, 0); assert.ok(['output_limit', 'invalid_output'].includes(result.status));
  }
});
test('native function calling runs via assistant.tool_calls + role:tool and drops the truncated last call', async () => {
  const seen = [];
  const executed = [];
  const result = await R.runAgent({ userText: 'task', history: [], outputTokens: 8192, system: async () => '规则',
    complete: async (msgs, delta, finish) => {
      seen.push(msgs);
      if (seen.length === 1) {
        finish('length'); // 最后一个调用参数没写完，现实里即 length
        return {
          content: '',
          toolCalls: [
            { index: 0, id: 'call_0', name: 'card.add', arguments: JSON.stringify({ name: 'A' }) },
            { index: 1, id: 'call_1', name: 'card.set', arguments: '{"value":1' },
          ],
        };
      }
      finish('stop');
      return { content: '全部完成', toolCalls: [] };
    },
    execute: async (calls) => {
      executed.push(...calls.map((c) => c.tool));
      return { text: 'ok', records: calls.map((c) => ({ ...c, status: 'success', content: 'ok' })), approved: [] };
    },
    onText: () => {},
  });
  assert.deepEqual(executed, ['card.add'], '只有参数完整的调用被执行，截断的最后一个丢弃');
  assert.equal(result.status, 'completed');
  const round2 = seen[1];
  const ai = round2.find((m) => m.role === 'assistant');
  assert.ok(ai?.tool_calls?.[0]?.id === 'call_0', 'assistant 消息带原生 tool_calls');
  assert.ok(round2.some((m) => m.role === 'tool' && m.tool_call_id === 'call_0'), '结果以 role:tool 回传');
});
test('oversized batches are mechanically capped and assistant history stays compressed', async () => {
  const perRound = [], sent = [];
  const many = Array.from({ length: 12 }, (_, i) => ({ tool: 'card.add', args: { name: `C${i}` } }));
  const result = await R.runAgent({ userText: 'task', history: [], outputTokens: 8192, system: async () => '规则',
    complete: async (msgs, delta, finish) => {
      sent.push(msgs);
      finish('stop');
      if (perRound.length === 0) return { content: json(many), toolCalls: [] };
      if (perRound.length === 1) return { content: json(many.slice(8)), toolCalls: [] };
      return { content: '全部完成', toolCalls: [] };
    },
    execute: async (calls) => {
      perRound.push(calls.length);
      return { text: 'ok', records: calls.map((c) => ({ ...c, status: 'success', content: 'ok' })), approved: [] };
    },
    onText: () => {},
  });
  assert.deepEqual(perRound, [8, 4], '12 个动作被切成 8 + 4 两批');
  assert.equal(result.status, 'completed');
  // 第二轮起，历史消息里不再带大段工具 JSON（系统提示词里的示例除外）
  for (const msgs of sent.slice(1)) {
    assert.ok(msgs.filter((m) => m.role !== 'system').every((m) => !m.content.includes('"actions"')), 'assistant 历史已压缩，不再重发工具 JSON');
  }
});
test('stop ending with a comma is not falsely reported as max-token truncation', async () => {
  const result = await R.runAgent({ userText: 'task', history: [], outputTokens: 4096, system: async () => '',
    complete: async (_, delta, finish) => { finish('stop'); delta('例如，'); return { content: '例如，', toolCalls: [] }; }, execute: async () => { throw new Error('unexpected'); }, onText: () => {},
  });
  assert.equal(result.status, 'completed');
});
test('runtime returns explicit round-limit status', async () => {
  let shown = '';
  const result = await R.runAgent({ userText: 'task', history: [], maxRounds: 2, outputTokens: 1000, system: async () => '',
    complete: async (_, delta, finish) => { finish('stop'); delta(json([{ tool: 'deck.list', args: {} }])); return { content: json([{ tool: 'deck.list', args: {} }]), toolCalls: [] }; },
    execute: async () => ({ text: 'read', records: [], approved: [] }), onText: (value) => shown = value,
  });
  assert.equal(result.status, 'round_limit'); assert.match(shown, /2 轮/);
});
test('one replayed write can recover using cached results; repeated failures stop the loop', async () => {
  let rounds = 0;
  const setup = {
    userText: 'task', history: [], outputTokens: 4096, system: async () => '', onText: () => {},
    execute: async () => ({ text: 'cached created A', records: [{ ...add, status: 'replayed', content: 'cached created A' }], approved: [] }),
  };
  const recovered = await R.runAgent({ ...setup, complete: async (_, delta, finish) => { finish('stop'); const r = ++rounds === 1 ? json([add]) : '已核对完成'; delta(r); return { content: r, toolCalls: [] }; } });
  assert.equal(recovered.status, 'completed'); assert.equal(rounds, 2);
  const blocked = await R.runAgent({ ...setup, complete: async (_, delta, finish) => { finish('stop'); const r = json([add]); delta(r); return { content: r, toolCalls: [] }; } });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.rounds, 2);
});
test('executor records completed writes, stops subsequent writes on abort, and deduplicates successful writes across rounds', async () => {
  const controller = new AbortController(), journal = new Map(), records = [];
  let writes = 0;
  const tools = { 'card.add': async () => { writes++; controller.abort(); return '✅ created'; } };
  await assert.rejects(P.runToolCalls([add, { ...add, args: { name: 'B' } }], tools, { signal: controller.signal, journal, onRecord: (r) => records.push(r) }), { name: 'AbortError' });
  assert.equal(writes, 1); assert.equal(records.length, 1);
  const replay = await P.runToolCalls([add], tools, { journal });
  assert.equal(writes, 1); assert.equal(replay.records[0].status, 'replayed');
  assert.equal(P.callKey({ tool: 'x', args: { a: 1, b: 2 } }), P.callKey({ tool: 'x', args: { b: 2, a: 1 } }));
});
test('failed writes remain retryable and replace-import requires explicit destructive approval', async () => {
  const journal = new Map(); let writes = 0;
  const tools = { 'card.add': async () => ++writes === 1 ? '❌ failed' : '✅ fixed' };
  await P.runToolCalls([add], tools, { journal }); await P.runToolCalls([add], tools, { journal });
  assert.equal(writes, 2);
  let replaced = false;
  const call = { tool: 'doc.tableToCards', args: { mode: 'replace' } };
  assert.equal(P.callLevel(call), 'destructive');
  const denied = await P.runToolCalls([call], { 'doc.tableToCards': async () => { replaced = true; return '✅'; } });
  assert.equal(replaced, false); assert.equal(denied.records[0].status, 'denied');
});
test('target resolution rejects ambiguous and missing targets rather than choosing the first', () => {
  const items = [{ id: '1', name: '主牌组' }, { id: '2', name: '主牌组备份' }];
  const pick = (hint) => D.selectEntity(items, hint, (x) => x.id, (x) => x.name, true);
  assert.equal(pick('missing'), undefined); assert.equal(pick(''), undefined);
  assert.equal(pick('主牌组').id, '1'); assert.throws(() => pick('主牌'), /匹配多个/);
});
test('actual doc.read through executor can reconstruct a long document without double clipping', async () => {
  const body = '长文段落。'.repeat(3000);
  globalThis.testProject = { content: { decks: [], documents: [{ id: 'doc', title: 'long', kind: 'markdown', content: body }] } };
  const tools = actions.createAgentActions({ projectId: 'p', projectName: 'p', update: async () => {}, rename: async () => {} });
  let offset = 0, restored = '';
  do {
    const result = await P.runToolCalls([{ tool: 'doc.read', args: { doc: 'doc', offset } }], tools);
    assert.ok(!result.text.includes('已截断'));
    const match = result.text.match(/nextOffset=(\d+|null)\n([\s\S]*)/);
    assert.ok(match); restored += match[2]; offset = match[1] === 'null' ? null : Number(match[1]);
  } while (offset !== null);
  assert.equal(restored, body);
});
test('actual tableRead reports a resumable row offset within executor budget', async () => {
  globalThis.testProject = { content: { decks: [], documents: [{ id: 't', title: 'table', kind: 'table', table: { header: ['A', 'B'], rows: Array.from({ length: 30 }, (_, i) => [String(i), '文'.repeat(250)]) } }] } };
  const tools = actions.createAgentActions({ projectId: 'p', projectName: 'p', update: async () => { throw new Error('read must not write'); }, rename: async () => {} });
  const result = await P.runToolCalls([{ tool: 'doc.tableRead', args: { doc: 't', limit: 30 } }], tools);
  assert.ok(!result.text.includes('已截断'));
  const next = Number(result.text.match(/nextOffset=(\d+)/)?.[1]); assert.ok(next > 0 && next < 30);
  for (const tool of ['doc.tableStats', 'doc.tableFind']) {
    const result = await P.runToolCalls([{ tool, args: { doc: 't', query: '文' } }], tools);
    assert.equal(result.records[0].status, 'success');
  }
});

test('cancelling an outstanding approval does not leave the executor waiting or execute the action', async () => {
  const controller = new AbortController();
  const pending = P.runToolCalls([{ tool: 'deck.delete', args: {} }], { 'deck.delete': async () => { throw new Error('must not execute'); } }, {
    signal: controller.signal,
    approve: () => { controller.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(pending, { name: 'AbortError' });
});
test('read concurrency is bounded and successful updates may return to an earlier value', async () => {
  let running = 0, max = 0;
  const calls = Array.from({ length: 13 }, (_, n) => ({ tool: 'deck.list', args: { n } }));
  const result = await P.runToolCalls(calls, { 'deck.list': async ({ n }) => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 1)); running--; return String(n); } });
  assert.ok(max <= 4); assert.equal(result.text.split('\n').length, 13);
  const journal = new Map(), seen = [];
  for (const value of ['A', 'B', 'A']) await P.runToolCalls([{ tool: 'card.set', args: { value } }], { 'card.set': async ({ value }) => { seen.push(value); return '✅'; } }, { journal });
  assert.deepEqual(seen, ['A', 'B', 'A']);
});

const H = await load('./src/lib/agentHistory.ts');
test('history restores native pairs without duplicating display prose or leaving pending calls', () => {
  const restored = H.restoreHistory([{ id: 'a', role: 'assistant', content: 'DISPLAY', agentRun: { status: 'running', records: [], messages: [
    { role: 'user', content: 'original' },
    { role: 'assistant', content: '', tool_calls: [{id:'ok',type:'function',function:{name:'x',arguments:'{}'}},{id:'pending',type:'function',function:{name:'y',arguments:'{}'}}] },
    { role: 'tool', tool_call_id: 'ok', content: 'done' }
  ] }}]);
  assert.equal(restored[0].tool_calls.length, 1);
  assert.equal(restored[0].tool_calls[0].id, 'ok');
  assert.ok(!JSON.stringify(restored).includes('DISPLAY'));
  assert.match(restored.at(-1).content, /中断/);
});
test('history search and read are scoped and paginated', async () => {
  const tools = H.historyTools([{id:'one',role:'user',content:'约束'+ 'a'.repeat(7000)}]);
  assert.equal(JSON.parse(await tools['conversation.search']({query:'约束'}))[0].id, 'one');
  assert.equal(JSON.parse(await tools['conversation.readTurn']({id:'one'})).nextOffset, 6000);
  assert.match(await tools['conversation.readTurn']({id:'other'}), /未找到/);
});
test('runtime awaits durable checkpoints before executing mutations', async () => {
  let saved = false;
  await R.runAgent({userText:'test',history:[],system:async()=>'',outputTokens:1000,
    onCheckpoint:async (messages)=>{ if(messages.some(m=>m.role==='assistant')) saved=true; },
    complete:async()=>({content:json([add]),toolCalls:[],finishReason:'stop'}),
    execute:async()=>{assert.ok(saved); return {text:'done',records:[],approved:[]};},
    onText:()=>{},maxRounds:1});
});

const M = await load('./src/lib/agentMemory.ts');
test('task memory preserves initial request, recent changes, pinned constraints and execution status', () => {
 const chat = {id:'c',projectId:'p',title:'t',messages:Array.from({length:9},(_,i)=>({id:String(i),role:'user',content:i===0?'禁止修改背面':'修改'+i})), pinnedMemory:'最小字号24',todos:[{id:'t',text:'检查溢出',status:'pending'}]};
 const memory=M.taskMemory(chat);
 assert.match(memory,/禁止修改背面/); assert.match(memory,/修改8/); assert.match(memory,/最小字号24/); assert.match(memory,/pending/);
});
test('fork copies only selected history and clears authorizations and future todos', () => {
 const chat={id:'c',projectId:'p',title:'t',messages:[{id:'a',role:'user',content:'one'},{id:'b',role:'assistant',content:'two'}],context:{docIds:[],skills:[],approved:['delete']},todos:[{id:'future',text:'later',status:'done'}]};
 const fork=M.forkSession(chat,'a','new');
 assert.equal(fork.messages.length,1); assert.deepEqual(fork.context.approved,[]);assert.deepEqual(fork.todos,[]);
 fork.messages[0].content='changed';assert.equal(chat.messages[0].content,'one');
 assert.throws(()=>M.forkSession(chat,'missing','new'));
});

const eventRows = new Map();
globalThis.agentEventRows = eventRows;
const E = await load('./src/db/agentEvents.ts', [{name:'event-db',setup(build){
 build.onResolve({filter:/schema$/},()=>({path:'event-db',namespace:'event-db'}));
 build.onLoad({filter:/.*/,namespace:'event-db'},()=>({contents:`export const db={transaction:async (...args)=>args.at(-1)(), chats:{get:async()=>({id:'c'})},agentEvents:{bulkPut:async rows=>rows.forEach(r=>globalThis.agentEventRows.set(r.id,r)),where:()=>({equals:id=>({toArray:async()=>[...globalThis.agentEventRows.values()].filter(r=>r.chatId===id)})})}};`}));
}}]);
test('event checkpoints append idempotently and hydrate only their own session',async()=>{
 const items=[{role:'user',content:'one'},{role:'assistant',content:'two'}];
 await E.saveAgentItems('c','m',items,0);await E.saveAgentItems('c','m',items,0);
 assert.equal(eventRows.size,2);
 await E.saveAgentItems('other','m',[{role:'user',content:'private'}],0);
 const hydrated=await E.hydrateAgentItems({id:'c',messages:[{id:'m',agentRun:{status:'running',records:[]}}]});
 assert.deepEqual(hydrated.messages[0].agentRun.messages,items);
});
test('fork invalidates summaries referring to future conversation',()=>{
 const fork=M.forkSession({id:'c',messages:[{id:'a',role:'user',content:'x'}],title:'t',summary:{text:'future',throughMessageId:'b'}},'a','new');
 assert.equal(fork.summary,undefined);
});

test('large tool output is archived and returns a bounded retrievable reference', async()=>{
 let archived='';
 const result=await P.runToolCalls([{tool:'project.overview',args:{}}],{'project.overview':async()=> 'x'.repeat(9000)}, {storeResult:async(tool,content)=>{archived=content;return 'ref-one';}});
 assert.ok(archived.length>9000);assert.match(result.records[0].content,/ref-one/);assert.ok(result.records[0].content.length<4000);
});
test('archive failure never turns a successful mutation into a retryable failure', async()=>{
 const journal=new Map();let writes=0;
 const calls=[{tool:'card.add',args:{name:'once'}}];
 const options={journal,storeResult:async()=>{throw new Error('disk');}};
 const actions={'card.add':async()=>{writes++;return 'x'.repeat(9000);}};
 const first=await P.runToolCalls(calls,actions,options);
 assert.equal(first.records[0].status,'success');
 const second=await P.runToolCalls(calls,actions,options);
 assert.equal(second.records[0].status,'replayed');assert.equal(writes,1);
});

const V=await load('./src/lib/agentRevision.ts');
test('revision conflicts block repeated writes until a real project read completes',()=>{
 const guard=new V.RevisionGuard(1);
 assert.throws(()=>guard.before(2,false),/版本已变化/);
 assert.throws(()=>guard.before(2,false));
 guard.before(2,true);guard.after(2,false);
 assert.throws(()=>guard.before(2,false));
 guard.before(2,true);guard.after(2,true);guard.before(2,false);
 guard.after(3,false);guard.before(3,false);
});
test('summary candidates never split a user turn or include future summarized messages',()=>{
 const messages=Array.from({length:12},(_,i)=>({id:String(i),role:i%3===0?'user':'assistant',content:'x'}));
 const covered=M.summaryCandidates({messages,summary:{throughMessageId:'2'}});
 assert.equal(covered[0].id,'3');assert.equal(covered.at(-1).id,'5');
 assert.equal(messages[Number(covered.at(-1).id)+1].role,'user');
});
test('per-call guard checks every write and blocks the remaining batch after external edits',async()=>{
 let writes=0;let checks=0;
 const result=await P.runToolCalls([{tool:'card.update',args:{}},{tool:'card.update',args:{}}],{'card.update':async()=>{writes++;return 'ok';}}, {beforeCall:async()=>{if(++checks===2)throw new Error('version conflict');}});
 assert.equal(writes,1);assert.deepEqual(result.records.map(r=>r.status),['success','error']);
});

test('preparation-stage interruption is visible even before any transcript item exists',()=>{
 const history=H.restoreHistory([{id:'pending',role:'assistant',content:'',agentRun:{status:'running',records:[]}}]);
 assert.match(history[0].content,/准备或请求阶段中断/);
 assert.match(history[0].content,/未确认完成/);
});

const CP=await load('./src/lib/agentCompaction.ts');
test('manual compaction preserves source and refuses truncated summaries',async()=>{
 const chat={messages:Array.from({length:12},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:'history'}))};
 const original=JSON.stringify(chat);
 await assert.rejects(CP.compactSession(chat,32000,'qa',async()=>({text:'half',reason:'length'})),/未完整/);
 assert.equal(JSON.stringify(chat),original);
 const summary=await CP.compactSession(chat,32000,'qa',async()=>({text:'done',reason:'stop'}));
 assert.equal(summary.throughMessageId,'5');assert.equal(summary.text,'done');assert.equal(JSON.stringify(chat),original);
});
test('compaction handles short histories without making a model request',async()=>{
 let calls=0;await assert.rejects(CP.compactSession({messages:[]},32000,'qa',async()=>{calls++;return {text:'x',reason:'stop'};}),/历史不足/);assert.equal(calls,0);
});
test('stream captures usage-only events for context accounting',async()=>{
 const result=await S.readSSE(stream(event({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+event({choices:[],usage:{prompt_tokens:123,completion_tokens:8,total_tokens:131}})+'data: [DONE]\n\n'));
 assert.equal(result.usage.prompt_tokens,123);assert.equal(result.usage.total_tokens,131);
});

const MC=await load('./src/lib/modelCapacity.ts');
test('capacity follows actual model metadata and scoped presets with explicit manual override',()=>{
 const cfg={baseUrl:'https://api.deepseek.com/v1',model:'deepseek-v4-pro'};
 assert.equal(MC.resolveCapacity(cfg).tokens,1048576);
 assert.equal(MC.resolveCapacity({...cfg,model:'deepseek-flash'}).tokens,1048576);
 assert.equal(MC.resolveCapacity({...cfg,contextWindow:32768}).tokens,32768);
 assert.equal(MC.resolveCapacity({...cfg,contextWindow:32768,contextMode:'auto'}).tokens,1048576);
 const meta={scope:MC.modelScope(cfg.baseUrl),models:{'deepseek-v4-pro':{context_window:262144}}};
 assert.equal(MC.resolveCapacity({...cfg,modelLimits:meta}).tokens,262144);
 assert.equal(MC.resolveCapacity({...cfg,baseUrl:'https://other.test/v1',modelLimits:meta}).tokens,1048576);
 assert.equal(MC.resolveCapacity({...cfg,model:'unknown'}).tokens,65536);
 assert.equal(MC.resolveCapacity(cfg,'unknown').tokens,65536);
 assert.equal(MC.autoCompactThreshold(1048576),629145);
});
test('model discovery validates capacity metadata without guessing missing values',()=>{
 assert.equal(MC.parseModelLimits([{id:'a',context_window:1048576}]).a.context_window,1048576);
 assert.equal(MC.parseModelLimits([{id:'b',context_length:131072}]).b.context_window,131072);
 assert.deepEqual(MC.parseModelLimits([{id:'c',context_window:-1}]).c,{});
});

test('output budgets adapt to thinking mode, metadata, manual settings and chat overrides',()=>{
 const cfg={...config,model:'deepseek-v4-pro',outputMode:'auto',thinking:false};
 assert.equal(L.resolveOutputBudget(cfg).value,32768);
 assert.equal(L.resolveOutputBudget({...cfg,thinking:true}).value,65536);
 assert.equal(L.resolveOutputBudget({...cfg,thinking:true,thinkingEffort:'max'}).value,131072);
 assert.equal(L.resolveOutputBudget({...cfg,outputMode:'manual',maxTokens:131072}).value,131072);
 assert.equal(L.resolveOutputBudget({...cfg,outputMode:undefined,maxTokens:17152}).value,17152);
 const modelLimits={scope:MC.modelScope(cfg.baseUrl),models:{'deepseek-v4-pro':{max_output_tokens:24000,context_window:1048576}}};
 assert.equal(L.resolveOutputBudget({...cfg,modelLimits}).value,24000);
 assert.equal(L.resolveOutputBudget(cfg,'unknown').cap,32768);
 assert.equal(L.resolveOutputBudget(cfg,cfg.model,1800).value,1800);
});
test('128K manual output survives actual proxy and direct requests; summary overrides stay small',async()=>{
 const original=globalThis.fetch;
 try{for(const useProxy of [true,false]){
  let body;globalThis.fetch=async(_,init)=>{body=JSON.parse(init.body);return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]});};
  const cfg={...config,model:'deepseek-v4-pro',outputMode:'manual',maxTokens:131072,useProxy};
  await L.chatStream({cfg,messages:[]});assert.equal(body.max_tokens,131072);
  await L.chatStream({cfg:{...cfg,outputMode:'auto'},maxTokens:1800,messages:[]});assert.equal(body.max_tokens,1800);
 }}finally{globalThis.fetch=original;}
});
