/**
 * 智能体工具协议的自检脚本（纯逻辑，不需要浏览器）。
 * 运行：node frontend/test_agent_protocol.mjs
 *
 * 覆盖：
 *   1. 模型回复的各种 JSON 形态都能解析成工具调用
 *   2. 未实现 / 抛错的工具不会让整轮崩掉
 *   3. 系统提示词包含全部工具
 *   4. TOOL_NAMES 与 agentTools.ts 里实际实现的动作一一对应（防漏实现）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

const built = await esbuild.build({
  entryPoints: [path.join(here, 'src/lib/agentProtocol.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const code = built.outputFiles[0].text;
const P = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};

/* ---------- 1. 解析 ---------- */
console.log('\n[1] 解析模型回复');

{
  const r = P.parseReply('好的，我来加一张牌。\n```json\n{"actions":[{"tool":"card.add","args":{"deck":"主牌组","name":"火焰箭"}}]}\n```');
  ok(r.calls.length === 1, '围栏 JSON + actions 数组', JSON.stringify(r.calls));
  ok(r.calls[0]?.tool === 'card.add' && r.calls[0]?.args?.name === '火焰箭', '参数正确');
  ok(r.text.includes('我来加一张牌') && !r.text.includes('```json'), '保留正文、剔除代码块');
}
{
  const r = P.parseReply('```json\n{"tool":"card.batchSet","args":{"deck":"主牌组","field":"count","value":2}}\n```');
  ok(r.calls.length === 1 && r.calls[0].tool === 'card.batchSet', '单个对象（无 actions）');
}
{
  const r = P.parseReply('```json\n[{"action":"addCard","args":{"name":"寒冰箭"}},{"action":"setAllCount","args":{"n":3}}]\n```');
  ok(r.calls.length === 2, '顶层数组');
  ok(r.calls[0].tool === 'card.add', 'addCard → card.add 容错', r.calls[0]?.tool);
}
{
  const r = P.parseReply('这只是普通聊天，没有任何工具调用。');
  ok(r.calls.length === 0 && r.text.includes('普通聊天'), '纯文本不误判');
}
{
  const r = P.parseReply('先说两句\n```json\n{"actions":[]}\n```\n结束');
  ok(r.calls.length === 0 && r.text.includes('先说两句'), '空 actions 不误判');
}
{
  const r = P.parseReply('```json\n{ 这是一段坏 JSON```');
  ok(r.calls.length === 0 && r.text.includes('坏 JSON'), '坏 JSON 原样保留给用户');
}
{
  const r = P.parseReply('说明 A\n```json\n{"actions":[{"tool":"deck.list","args":{}}]}\n```\n说明 B\n```json\n{"actions":[{"tool":"doc.list","args":{}}]}\n```');
  ok(r.calls.length === 2 && r.calls[1].tool === 'doc.list', '一段回复里多个代码块');
}
{
  const r = P.parseReply('```\n{"actions":[{"tool":"card.add","args":{"name":"X"}}]}\n```');
  ok(r.calls.length === 1, '无语言标记的围栏也能解析');
}

/* ---------- 2. 执行 ---------- */
console.log('\n[2] 执行工具调用');

{
  const log = [];
  const actions = {
    'card.add': async (a) => { log.push(a.name); return `✅ 加了 ${a.name}`; },
    'deck.list': async () => '主牌组',
  };
  const r = await P.runToolCalls(
    [{ tool: 'card.add', args: { name: 'A' } }, { tool: 'card.add', args: { name: 'B' } }, { tool: 'deck.list', args: {} }],
    actions,
  );
  ok(log.join(',') === 'A,B', '按顺序执行');
  ok(r.text.includes('✅ 加了 A') && r.text.includes('主牌组'), '汇总结果文本');
}
{
  const r = await P.runToolCalls([{ tool: 'not.exist', args: {} }], {});
  ok(r.text.startsWith('❌') && r.text.includes('未知工具'), '未知工具返回可读错误');
}
{
  const r = await P.runToolCalls(
    [{ tool: 'x', args: {} }, { tool: 'y', args: {} }],
    { x: async () => { throw new Error('炸了'); }, y: async () => '✅ y 成功' },
  );
  ok(r.text.includes('炸了') && r.text.includes('y 成功'), '单条抛错不影响后续');
}

/* ---------- 2b. 权限分级 ---------- */
console.log('\n[2b] 分级 / 并行 / 截断 / 授权');

{
  ok(P.levelOf('project.overview') === 'read', '只读工具是 read 级');
  ok(P.levelOf('card.add') === 'write', '写入工具是 write 级');
  ok(P.levelOf('deck.delete') === 'destructive', '删除工具是 destructive 级');
  ok(P.levelOf('whatever') === 'write', '未登记工具保守按 write');
}
{
  // 连续只读调用并行：三条都同时开始才可能在 1 条完成前全部启动
  let running = 0;
  let maxRunning = 0;
  const slow = async () => {
    running += 1; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
    return 'ok';
  };
  const r = await P.runToolCalls(
    [{ tool: 'project.overview', args: {} }, { tool: 'deck.list', args: {} }, { tool: 'field.list', args: {} }],
    { 'project.overview': slow, 'deck.list': slow, 'field.list': slow },
  );
  ok(maxRunning >= 2, '只读调用并行执行', `最大并发 ${maxRunning}`);
  ok(r.text.split('\n').length === 3, '并行结果按原序输出');
}
{
  // 写入串行
  let running = 0;
  let maxRunning = 0;
  const slow = async () => {
    running += 1; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return 'ok';
  };
  await P.runToolCalls(
    [{ tool: 'card.add', args: {} }, { tool: 'card.add', args: {} }],
    { 'card.add': slow },
  );
  ok(maxRunning === 1, '写入调用串行执行', `最大并发 ${maxRunning}`);
}
{
  // 破坏性：拒绝
  let asked = 0;
  const r = await P.runToolCalls(
    [{ tool: 'deck.delete', args: { deck: '主牌组' } }],
    { 'deck.delete': async () => '不该被执行' },
    { approve: async () => { asked += 1; return false; } },
  );
  ok(asked === 1, '删除类工具会先问用户');
  ok(r.text.includes('⛔') && r.text.includes('拒绝'), '被拒绝后不执行');
}
{
  // 破坏性：允许一次
  const r1 = await P.runToolCalls(
    [{ tool: 'deck.delete', args: { deck: '主牌组' } }],
    { 'deck.delete': async () => '✅ 已删除' },
    { approve: async () => true },
  );
  ok(r1.text.includes('已删除'), '允许一次即执行');
  ok(r1.approved.length === 0, '「允许一次」不写入放行清单');
}
{
  // 破坏性：本次会话都允许 → 后续不再问
  const approved = new Set();
  let asked = 0;
  const A = { 'deck.delete': async () => '✅ 已删除' };
  const r1 = await P.runToolCalls(
    [{ tool: 'deck.delete', args: { deck: 'A' } }], A,
    { approve: async () => { asked += 1; return 'always'; }, approved },
  );
  const r2 = await P.runToolCalls(
    [{ tool: 'deck.delete', args: { deck: 'B' } }], A,
    { approve: async () => { asked += 1; return true; }, approved },
  );
  ok(asked === 1, '「本次会话都允许」后不再重复询问', `asked=${asked}`);
  ok(r1.approved.includes('deck.delete') && r2.approved.includes('deck.delete'), '放行清单会回传给调用方持久化');
  ok(r2.text.includes('已删除'), '已放行时直接执行');
}
{
  // 超长结果截断
  const r = await P.runToolCalls(
    [{ tool: 'card.list', args: {} }],
    { 'card.list': async () => 'x'.repeat(9000) },
    { maxResultChars: 500 },
  );
  ok(r.text.includes('已截断') && r.text.length < 800, '超长结果会被截断', `长度 ${r.text.length}`);
  const short = await P.runToolCalls(
    [{ tool: 'card.list', args: {} }],
    { 'card.list': async () => 'short' },
    { maxResultChars: 500 },
  );
  ok(!short.text.includes('已截断'), '短结果不截断');
}
{
  const d = P.describeCall({ tool: 'card.delete', args: { deck: '主牌组', card: '火焰箭' } });
  ok(d.includes('card.delete') && d.includes('火焰箭'), '确认弹窗能说人话', d);
}

/* ---------- 2b2. 坏 JSON 修复（多行 content 是文档写不进去的头号原因） ---------- */
console.log('\n[2b2] 坏 JSON 修复');

{
  // 模型写多行 content 时最常输出裸换行，合法 JSON 里必须是 \n
  const bad = '{"actions":[{"tool":"doc.create","args":{"title":"规则","content":"第一行\n第二行\n第三行"}}]}';
  let calls = null;
  try { calls = P.parseReply('```json\n' + bad + '\n```').calls; } catch { /* noop */ }
  ok(calls && calls.length === 1, '裸换行的多行 content 也能解析', JSON.stringify(calls));
  ok(calls?.[0]?.args?.content === '第一行\n第二行\n第三行', '换行被还原成真正的内容',
    JSON.stringify(calls?.[0]?.args?.content));
}
{
  const r = P.parseReply('```json\n{"actions":[{"tool":"doc.update","args":{"doc":"规则",}}]}\n```');
  ok(r.calls.length === 1 && r.calls[0].tool === 'doc.update', '尾随逗号也能解析');
}
{
  const r = P.parseReply('```json\n{"actions":[{"tool":"card.add","args":{"name":"A"}}]}\n```');
  ok(r.calls.length === 1 && r.calls[0].args.name === 'A', '本来就合法的 JSON 不受影响');
}

/* ---------- 2b3. 历史压缩与 token 估算 ---------- */
console.log('\n[2b3] 历史压缩 / token 估算');

{
  const parsed = P.parseReply('我来改一下。\n```json\n{"actions":[{"tool":"card.add","args":{"deck":"主牌组","name":"火焰箭","values":{"count":3,"cost":2}}}]}\n```');
  const c = P.compressReply('raw', parsed);
  ok(c.includes('火焰箭') === false, '压缩后不再带大段 JSON', c);
  ok(c.includes('card.add'), '压缩后仍记着调用过什么', c);
  ok(c.includes('我来改一下'), '保留给用户看的正文');
  ok(c.length < 120, '体积足够小', `长度 ${c.length}`);
}
{
  ok(P.estimateTokens('你好世界') > 0, '中文有 token 估算');
  ok(P.estimateTokens('') === 0, '空串为 0');
  const cn = P.estimateTokens('你'.repeat(100));
  const en = P.estimateTokens('hello '.repeat(100));
  ok(cn > 100 && cn < 200, '100 个汉字约 150 token', String(cn));
  ok(en > 100 && en < 200, '100 个英文词约 130 token', String(en));
}

/* ---------- 2c. 截断检测 ---------- */
console.log('\n[2c] 输出截断检测');

{
  ok(!P.looksTruncated('好的，已经加好了。'), '完整回复不算截断');
  ok(!P.looksTruncated('```json\n{"actions":[{"tool":"card.add","args":{"name":"A"}}]}\n```'), '闭合的 JSON 块不算截断');
  ok(P.looksTruncated('我来改一下\n```json\n{"actions":[{"tool":"card.add","args":{"name":"A"}}'), '围栏落单算截断');
  ok(P.looksTruncated('来，加几张：\n```json\n{"actions":[{"tool":"card.add","args":'), '半截 args 算截断');
  ok(P.looksTruncated('{"actions":[{"tool":"card.add","args":{"name":"A"},'), '结尾停在半截对象算截断');
  ok(!P.looksTruncated(''), '空串不算截断');
}

/* ---------- 2d. DeepSeek 原生 DSML 泄漏 ---------- */
console.log('\n[2d] DSML 标签（DeepSeek 原生调用格式泄漏）');

// 真实例子：21 个建骨架动作之后，模型突然改用原生标签，且 args 被吐成 "true"
const DSML_BAD = [
  '好的，现在补样式。',
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="element.style">',
  '<｜｜DSML｜｜ parameter name="args" string="true">true</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="tool" string="true">element.style</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n');

{
  ok(P.detectDsml(DSML_BAD), '认出 DSML 标签');
  ok(!P.detectDsml('```json\n{"actions":[]}\n```'), '正常 JSON 不误报');
  ok(!P.detectDsml('今天天气不错'), '普通文本不误报');

  const r = P.parseReply(DSML_BAD);
  ok(!/DSML/.test(r.text), '正文里不再出现 DSML 乱码', r.text);
  ok(r.text.includes('现在补样式'), '正文里的正常中文保留', r.text);
  ok(r.calls.length === 0, 'args 残缺（值为 true）的调用不执行', JSON.stringify(r.calls));
  ok(P.formatCorrection(DSML_BAD).includes('JSON'), '给出改用 JSON 的重发要求');
  ok(P.formatCorrection('普通回复') === '', '正常回复不产生纠正提示');
}

{
  // 完整的 DSML：应该被救回来当工具调用用
  const good = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="element.style">',
    '<｜｜DSML｜｜ parameter name="args" string="false">{"element":"标题条","fontSize":48}</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  const r = P.parseReply(good);
  ok(r.calls.length === 1, '完整 DSML 被解析成 1 个动作', JSON.stringify(r.calls));
  ok(r.calls[0]?.tool === 'element.style', '工具名正确', r.calls[0]?.tool);
  ok(r.calls[0]?.args?.fontSize === 48, 'args 里的值解析正确', JSON.stringify(r.calls[0]?.args));
}

{
  // 被掐断的 DSML：只开了头没有闭合
  const cut = '我来改一下\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="element.style">';
  ok(P.looksTruncated(cut), '只开未闭的 DSML 判定为截断');
  const r = P.parseReply(cut);
  ok(!/DSML/.test(r.text), '截断的 DSML 也从正文里清掉', r.text);
}

{
  // JSON 与 DSML 混在同一轮：两边都要拿到
  const mixed = '先看一眼：\n```json\n{"actions":[{"tool":"element.list","args":{"deck":"主牌组"}}]}\n```\n'
    + '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="element.style">'
    + '<｜｜DSML｜｜ parameter name="args" string="false">{"element":"底条","fill":"#111"}</｜｜DSML｜｜ parameter>'
    + '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const r = P.parseReply(mixed);
  ok(r.calls.length === 2, 'JSON 与 DSML 的调用都被收集', JSON.stringify(r.calls.map((c) => c.tool)));
  ok(!/DSML/.test(r.text), '混合场景正文也干净');
}

/* ---------- 3. 提示词 ---------- */
console.log('\n[3] 系统提示词');

{
  const sys = P.buildSystemPrompt('项目「测试」：1 个牌组');
  ok(sys.includes('项目「测试」'), '嵌入工程快照');
  const missing = P.TOOL_NAMES.filter((n) => !sys.includes(n));
  ok(missing.length === 0, `提示词包含全部 ${P.TOOL_NAMES.length} 个工具`, missing.join(','));
  ok(/```json/.test(sys) && /"actions"/.test(sys), '给出 JSON 调用示例');
  ok(new Set(P.TOOL_NAMES).size === P.TOOL_NAMES.length, '工具名无重复');
  ok(sys.includes('⚠️需用户确认'), '删除类工具在说明书里标注需确认');
  ok(/DSML/.test(sys) && /严禁/.test(sys), '明确禁止 DSML / 标签式调用语法');
  // 精简模式下工具说明书会被压成名字，但这条禁令必须留着，否则续轮更容易跑偏
  const compact = P.buildSystemPrompt({ snapshot: '项目「测试」：1 个牌组', compact: true });
  ok(/DSML/.test(compact), '精简模式仍保留 DSML 禁令');
}

/* ---------- 3b. 动态上下文 ---------- */
console.log('\n[3b] 上下文挂载（知识包 / 文档 / 待办 / 联网）');

{
  const sys = P.buildSystemPrompt({
    snapshot: '项目「X」',
    skills: [{ title: '卡牌数值平衡', content: '费用 N ≈ 攻防 2N+2' }],
    docs: [{ title: '规则说明书', content: '| 名称 | 费用 |\n| --- | --- |\n| 火球 | 3 |' }],
    todos: [{ text: '补齐费用', status: 'done' }, { text: '平衡数值', status: 'in_progress' }],
    web: true,
    extra: '回答只用中文',
  });
  ok(sys.includes('参考资料：知识包') && sys.includes('2N+2'), '知识包拼进前缀');
  ok(sys.includes('参考资料：项目文档') && sys.includes('火球'), '文档拼进前缀');
  ok(sys.includes('当前待办') && sys.includes('- [x] 补齐费用') && sys.includes('- [~] 平衡数值'), '待办拼进前缀');
  ok(sys.includes('web.search') && sys.includes('web.fetch'), '联网工具出现在说明书里');
  ok(sys.includes('不要凭记忆编造'), '联网规则存在');
  ok(sys.includes('回答只用中文'), '用户附加要求拼在末尾');
  // 顺序：参考资料要在工具之前
  ok(sys.indexOf('参考资料：知识包') < sys.indexOf('## 可用工具'), '参考资料排在工具之前');
}
{
  const sys = P.buildSystemPrompt({ snapshot: 'X', web: false });
  ok(sys.includes('当前未开放联网工具'), '关闭联网时给出替代规则');
}
{
  const sys = P.buildSystemPrompt({
    snapshot: 'X',
    docs: [{ title: '长文档', content: 'y'.repeat(20000) }],
    maxRefChars: 1000,
  });
  ok(sys.includes('共 20000 字符') && sys.includes('doc.read'), '超长文档会被截断');
}
{
  const sys = P.buildSystemPrompt({ snapshot: 'X', tools: P.TOOL_SPECS.filter((s) => s.level === 'read') });
  ok(!/^- card\.add /m.test(sys), 'tools 子集限制生效');
  ok(sys.includes('project.overview'), '子集里保留只读工具');
}

/* ---------- 3c. Every request keeps required context ---------- */
console.log('\n[3c] 多轮上下文完整性');
{
  const full = P.buildSystemPrompt({ snapshot: 'X', skills: [{ title: '平衡', content: '费用 N ≈ 2N+2' }] });
  const next = P.buildSystemPrompt({ snapshot: 'X', skills: [{ title: '平衡', content: '费用 N ≈ 2N+2' }], compact: true });
  ok(next === full, '旧 compact 参数不再删除模型依赖的上下文');
  ok(next.includes('2N+2'), '续轮保留知识包约束');
  ok(/^- card\.add \{/m.test(next), '续轮保留工具参数');
  ok(!next.includes('已在上一轮给出'), '不假设服务端记住已删除消息');
}

/* ---------- 4. 与实际实现对齐 ---------- */
console.log('\n[4] 说明书与实现对齐');

{
  const src = readFileSync(path.join(here, 'src/lib/agentTools.ts'), 'utf8');
  const impl = new Set([...src.matchAll(/A\['([a-zA-Z.]+)'\]/g)].map((m) => m[1]));
  const declared = new Set(P.TOOL_NAMES);
  const notImpl = [...declared].filter((n) => !impl.has(n));
  const notDeclared = [...impl].filter((n) => !declared.has(n));
  ok(notImpl.length === 0, '说明书里的每个工具都已实现', notImpl.join(','));
  ok(notDeclared.length === 0, '每个实现都在说明书里', notDeclared.join(','));
  console.log(`     已实现 ${impl.size} 个动作`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
