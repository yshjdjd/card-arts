/**
 * 量一量「系统提示词前缀」到底有多重，以及一轮对话实际会发多少东西。
 *
 * 输出的是客观字符数 + estimateTokens 的估算，用来回答：
 *   默认前缀多少 token？挂载文档/知识包后会涨到多少？历史消息会发多少？
 *
 * 运行：node frontend/measure_prompt.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

async function load(entry) {
  const built = await esbuild.build({
    entryPoints: [path.join(here, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const code = built.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const P = await load('src/lib/agentProtocol.ts');
const S = await load('src/lib/skills.ts');

const fmt = (n) => n.toLocaleString('en-US');
const line = (name, text) => {
  const chars = text.length;
  const tok = P.estimateTokens(text);
  console.log(`  ${name.padEnd(30)} ${fmt(chars).padStart(7)} 字符   ≈ ${fmt(tok).padStart(6)} tokens`);
  return tok;
};

/* ---------- 构造一个典型工程快照 ---------- */

function snapshot(decks = 1, cardsPerDeck = 12) {
  const out = [`项目「测试项目」（id=p1）`];
  let totalCards = 0;
  for (let i = 0; i < decks; i += 1) totalCards += cardsPerDeck;
  out.push(`${decks} 个牌组 / ${totalCards} 条卡牌（展开 ${totalCards} 张）/ 2 篇文档`);
  out.push(`导出设置：{"dpi":300,"bleedMm":3,"duplex":true,"flipOnBack":true,"cutLines":true,"pageSize":"A4"}`);
  out.push('');
  for (let i = 0; i < decks; i += 1) {
    out.push(`【牌组 主牌组${i + 1}】id=d${i + 1}`);
    out.push(`  字段：名称(f_name:text)，费用(f_cost:number)，攻击(f_atk:number)，生命(f_hp:number)，` +
      `类型(f_type:select[随从/法术/装备])，描述(f_desc:text)，数量(f_count:number)，稀有度(f_rare:select[普通/稀有/史诗/传说])`);
    out.push(`  正面版式：750×1050px，8 元素`);
    out.push(`    e1:标题:text→f_name，e2:费用:text→f_cost，e3:攻击:text→f_atk，e4:生命:text→f_hp，e5:类型:text→f_type，e6:描述:text→f_desc，e7:插画:image，e8:边框:rectangle`);
    out.push(`  背面版式：750×1050px，2 元素`);
    out.push(`  卡牌 ${cardsPerDeck} 条，前 12 条：`);
    for (let c = 0; c < Math.min(cardsPerDeck, 12); c += 1) {
      out.push(`    · 名称="卡牌${c + 1}"，费用=${c % 8}，攻击=${c % 7}，生命=${c % 9}，类型="随从"，描述="一段描述文字，大概这么长"，数量=3 [c${c + 1}]`);
    }
    out.push('');
  }
  out.push('【文档】📝文本 规则说明书(doc1)、📊表格 卡牌清单(doc2)');
  return out.join('\n');
}

const skillsRef = (keys) => S.allSkills()
  .filter((s) => keys.includes(s.key))
  .map((s) => ({ title: s.name, content: s.body }));

const defaultKeys = S.defaultSkillKeys();
const allKeys = S.allSkills().map((s) => s.key);

console.log('\n=== 1. 系统提示词前缀（每轮请求都会重发一遍）===');
console.log('\n  [基线：1 牌组 / 12 卡牌，只开默认知识包，不挂文档]');
const base = P.buildSystemPrompt({
  snapshot: snapshot(1, 12),
  skills: skillsRef(defaultKeys),
  web: true,
});
line('合计', base);

console.log('\n  [拆解]');
line('· 工具说明书（63 个）', P.TOOL_DOCS.join('\n'));
line('· 默认知识包 x2', skillsRef(defaultKeys).map((s) => s.content).join('\n'));
line('· 工程快照（1 牌组/12 卡）', snapshot(1, 12));

console.log('\n  [变量影响]');
line('2 牌组 / 12 卡牌', P.buildSystemPrompt({ snapshot: snapshot(2, 12), skills: skillsRef(defaultKeys), web: true }));
// 快照只列前 12 条卡牌（projectOverview 就是这么做的），所以卡牌总数对前缀影响很小
line('2 牌组 / 40 条（快照只列前12）', P.buildSystemPrompt({ snapshot: snapshot(2, 40), skills: skillsRef(defaultKeys), web: true }));
const t4 = line('开全部 6 个知识包', P.buildSystemPrompt({ snapshot: snapshot(1, 12), skills: skillsRef(allKeys), web: true }));
const t5 = line('再挂 1 篇 5000 字文档', P.buildSystemPrompt({
  snapshot: snapshot(1, 12), skills: skillsRef(defaultKeys),
  docs: [{ title: '规则说明书', content: '第一条规则的描述文字。'.repeat(500) }], web: true,
}));
const t6 = line('知识包全开 + 3 篇长文档', P.buildSystemPrompt({
  snapshot: snapshot(1, 12), skills: skillsRef(allKeys),
  docs: [
    { title: '规则说明书', content: '第一条规则的描述文字。'.repeat(500) },
    { title: '世界观设定', content: '世界观的段落文字内容。'.repeat(500) },
    { title: '卡牌清单', content: '| 名称 | 费用 | 攻击 | 生命 |\n| --- | --- | --- | --- |\n'.repeat(1) + '| 卡牌1 | 3 | 2 | 3 |\n'.repeat(200) },
  ], web: true,
}));

/* ---------- 2. 一轮对话总共发多少 ---------- */

console.log('\n  [精简模式：多轮循环第 2 轮起]');
const baseCompact = P.buildSystemPrompt({ snapshot: snapshot(1, 12), skills: skillsRef(defaultKeys), web: true, compact: true });
line('合计（精简版）', baseCompact);
console.log(`  → 相对完整版省 ${(100 - (P.estimateTokens(baseCompact) / P.estimateTokens(base)) * 100).toFixed(0)}%`);

console.log('\n=== 2. 一轮对话实际发送量（含历史）===');

const HISTORY_LIMIT = 24;
function conversation(rounds, historyMsgs = 10) {
  // 历史：近 N 条（toPromptMessages 的 limit=24，且过滤掉 system）
  const hist = [];
  for (let i = 0; i < historyMsgs; i += 1) {
    hist.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '把费用大于 5 的卡牌都减 1，然后告诉我改了哪些。'.repeat(2) });
  }
  const full = P.buildSystemPrompt({ snapshot: snapshot(1, 12), skills: skillsRef(defaultKeys), web: true });
  const comp = P.buildSystemPrompt({ snapshot: snapshot(1, 12), skills: skillsRef(defaultKeys), web: true, compact: true });
  // 每轮：system(重拼，第 2 轮起用精简版) + 历史 + 本轮新增（assistant 已压缩 + 工具结果）
  const toolResult = Array.from({ length: 6 }, (_, i) => `[card.update] ✅ 第 ${i + 1} 张已改为 费用=4（共 12 字）`).join('\n');
  const compressed = '已按你的要求把费用大于 5 的卡牌各减 1。\n[本轮调用了：card.find、card.update]';
  let perRound = [];
  let total = 0;
  for (let r = 0; r < rounds; r += 1) {
    const sys = r === 0 ? full : comp;
    const parts = [sys, ...hist.map((m) => m.content)];
    for (let k = 0; k < r; k += 1) {
      parts.push(compressed);      // 上一轮助手（已压缩）
      parts.push(`以上是工具执行结果…\n${toolResult}`); // 工具结果回传
    }
    parts.push('把所有费用大于 5 的卡牌减 1');
    const n = P.estimateTokens(parts.join('\n'));
    perRound.push(n);
    total += n;
  }
  return { perRound, total };
}

for (const rounds of [1, 2, 3, 4]) {
  const { perRound, total } = conversation(rounds, 10);
  console.log(`  ${rounds} 轮工具循环（历史 10 条）：每轮 ${perRound.map((n) => fmt(n)).join(' → ')}` +
    `  累计发送 ${fmt(total)} tokens`);
}
console.log('  （注：这是"发给模型的量"，4 轮循环会把前缀重发 4 次，所以累计远大于单轮）');

console.log('\n=== 3. 历史消息 =======');
console.log(`  toPromptMessages 的 limit = ${HISTORY_LIMIT} → 只取最近 ${HISTORY_LIMIT} 条（不含 system）`);
console.log('  不是全部历史；更早的会被丢掉。工具循环里新增的内容不进 chat.messages，只活在当前请求的 convo 里。');

console.log('\n=== 4. 与「最大 Token」的关系 =======');
console.log('  最大 Token = 每次请求的【输出】上限，各轮独立、不累积。');
console.log(`  前缀 = 【输入】，按当前默认约 ${fmt(P.estimateTokens(base))} tokens/轮；输入越重，留给输出的余量越小。`);
console.log(`  若模型上下文 32k：前缀占 ${((P.estimateTokens(base) / 32768) * 100).toFixed(0)}%；` +
  `全开知识包+长文档时占 ${((t6 / 32768) * 100).toFixed(0)}%。`);
console.log();
