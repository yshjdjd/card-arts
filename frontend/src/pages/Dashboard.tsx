import React, { useRef, useState } from 'react';
import { Modal, useConfirm, useToast, Empty } from '../components/ui';
import { useProjectList, navigate, useApp } from '../state/store';
import { api } from '../api/client';
import { formatBytes, formatDate, downloadJSON, safeName } from '../lib/utils';
import { pullAll } from '../db/sync';
import { db } from '../db/schema';
import WorkspaceCard from '../features/WorkspaceCard';
import type { ProjectContent } from '../lib/types';

/** 一个可直接上手的示例工程，让新用户第一次打开就有东西可看 */
function demoContent(): ProjectContent {
  const now = new Date().toISOString();
  const fid = (s: string) => `f_${s}`;
  return {
    decks: [
      {
        id: 'deck_demo',
        name: '示例牌组',
        fields: [
          { id: fid('name'), name: '名称', type: 'text', showInTable: true },
          { id: fid('cost'), name: '费用', type: 'number', showInTable: true },
          { id: fid('type'), name: '类型', type: 'select', options: ['随从', '法术', '装备'], showInTable: true },
          { id: fid('atk'), name: '攻击', type: 'number', showInTable: true },
          { id: fid('hp'), name: '生命', type: 'number', showInTable: true },
          { id: fid('desc'), name: '描述', type: 'text', showInTable: true },
          { id: 'count', name: '数量', type: 'number', showInTable: true },
        ],
        cards: [
          { id: 'c1', values: { [fid('name')]: '烈焰术士', [fid('cost')]: 3, [fid('type')]: '随从', [fid('atk')]: 4, [fid('hp')]: 3, [fid('desc')]: '登场：对随机敌方造成 2 点伤害。', count: 2 } },
          { id: 'c2', values: { [fid('name')]: '寒冰箭', [fid('cost')]: 1, [fid('type')]: '法术', [fid('atk')]: 0, [fid('hp')]: 0, [fid('desc')]: '造成 3 点伤害并冻结目标。', count: 3 } },
          { id: 'c3', values: { [fid('name')]: '钢制长剑', [fid('cost')]: 2, [fid('type')]: '装备', [fid('atk')]: 2, [fid('hp')]: 0, [fid('desc')]: '装备的角色攻击 +2。', count: 1 } },
        ],
        frontLayout: {
          id: 'lay_front',
          name: '正面',
          width: 750, height: 1050, widthMm: 63.5, heightMm: 88.9,
          backgroundColor: '#fffdf7', borderColor: '#3f3f46', borderWidth: 3, borderRadius: 28,
          elements: [
            { id: 'e_bg', kind: 'rectangle', name: '卡框', x: 24, y: 24, width: 702, height: 1002, rotation: 0, fill: '#ffffff', color: '#000', borderColor: '#d4d4d8', borderWidth: 2, borderRadius: 22 },
            { id: 'e_title', kind: 'text', name: '标题', x: 60, y: 60, width: 630, height: 70, rotation: 0, fill: 'transparent', color: '#18181b', fieldId: fid('name'), fontSize: 46, maxFontSize: 56, autoFit: true, fontWeight: 'bold', horizontalAlign: 'center', verticalAlign: 'middle' },
            { id: 'e_cost', kind: 'ellipse', name: '费用圈', x: 44, y: 44, width: 96, height: 96, rotation: 0, fill: '#2563eb', color: '#fff', },
            { id: 'e_cost_t', kind: 'text', name: '费用值', x: 44, y: 44, width: 96, height: 96, rotation: 0, fill: 'transparent', color: '#ffffff', fieldId: fid('cost'), fontSize: 44, autoFit: true, horizontalAlign: 'center', verticalAlign: 'middle', fontWeight: 'bold' },
            { id: 'e_art', kind: 'rectangle', name: '插画区', x: 60, y: 160, width: 630, height: 470, rotation: 0, fill: '#f4f4f5', color: '#000', borderColor: '#e4e4e7', borderWidth: 2, borderRadius: 14 },
            { id: 'e_type', kind: 'text', name: '类型', x: 60, y: 650, width: 630, height: 42, rotation: 0, fill: 'transparent', color: '#71717a', fieldId: fid('type'), fontSize: 28, horizontalAlign: 'center', verticalAlign: 'middle' },
            { id: 'e_desc', kind: 'text', name: '描述', x: 70, y: 700, width: 610, height: 180, rotation: 0, fill: 'transparent', color: '#27272a', fieldId: fid('desc'), fontSize: 28, autoFit: true, wrapMode: 'word', horizontalAlign: 'center', verticalAlign: 'middle', lineHeight: 1.4 },
            { id: 'e_atk', kind: 'text', name: '攻击力', x: 60, y: 900, width: 120, height: 100, rotation: 0, fill: 'transparent', color: '#b91c1c', fieldId: fid('atk'), fontSize: 52, fontWeight: 'bold', horizontalAlign: 'center', verticalAlign: 'middle', displayCondition: { type: 'comparison', fieldId: fid('type'), operator: 'equals', value: '随从' } },
            { id: 'e_hp', kind: 'text', name: '生命值', x: 570, y: 900, width: 120, height: 100, rotation: 0, fill: 'transparent', color: '#15803d', fieldId: fid('hp'), fontSize: 52, fontWeight: 'bold', horizontalAlign: 'center', verticalAlign: 'middle', displayCondition: { type: 'comparison', fieldId: fid('type'), operator: 'equals', value: '随从' } },
          ],
        },
        backLayout: {
          id: 'lay_back',
          name: '背面',
          width: 750, height: 1050, widthMm: 63.5, heightMm: 88.9,
          backgroundColor: '#1e293b', borderColor: '#0f172a', borderWidth: 3, borderRadius: 28,
          elements: [
            { id: 'b1', kind: 'rectangle', name: '内框', x: 44, y: 44, width: 662, height: 962, rotation: 0, fill: 'transparent', color: '#fff', borderColor: '#475569', borderWidth: 3, borderRadius: 18 },
            { id: 'b2', kind: 'text', name: '标题', x: 100, y: 460, width: 550, height: 130, rotation: 0, fill: 'transparent', color: '#e2e8f0', text: 'CARD ARTS', fontSize: 72, fontWeight: 'bold', horizontalAlign: 'center', verticalAlign: 'middle' },
          ],
        },
        useSharedBack: true,
      },
    ],
    documents: [
      { id: 'd1', title: '设计说明', content: '# 设计说明\n\n- 主题：奇幻对战\n- 目标人数：2-4 人\n- 一局时长：约 30 分钟\n\n## 待办\n1. 补充 10 张随从\n2. 平衡费用曲线\n', createdAt: now, updatedAt: now },
    ],
    settings: { lang: 'zh', syncEnabled: true },
  };
}

export default function Dashboard() {
  const { projects, create, importJSON, remove, duplicate } = useProjectList();
  const { syncNow } = useApp();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const stats = (c: ProjectContent) => {
    const cards = c.decks?.reduce((n, d) => n + (d.cards?.length ?? 0), 0) ?? 0;
    return { decks: c.decks?.length ?? 0, cards, docs: c.documents?.length ?? 0 };
  };

  const onCreate = async (kind: 'blank' | 'demo') => {
    const name = newName.trim() || (kind === 'demo' ? '示例工程' : '未命名项目');
    const p = kind === 'demo'
      ? await importJSON({ content: demoContent() }, name)
      : await create(name);
    setShowNew(false);
    setNewName('');
    toast(`已创建「${name}」`, 'ok');
    navigate(`p/${p.id}/cards`);
  };

  const onImportFile = async (f: File) => {
    try {
      const json = JSON.parse(await f.text());
      const p = await importJSON(json, json?.name ?? f.name.replace(/\.(json|cardarts)$/i, ''));
      toast('导入成功', 'ok');
      navigate(`p/${p.id}/cards`);
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, 'err');
    }
  };

  const onBackup = async (id: string) => {
    const p = await db.projects.get(id);
    if (!p) return;
    downloadJSON(
      { format: 'cardarts.project.v1', exportedAt: new Date().toISOString(), name: p.name, content: p.content },
      `${safeName(p.name)}.cardarts.json`,
    );
    toast('已导出项目备份');
  };

  const onPull = async () => {
    try {
      const n = await pullAll();
      await syncNow();
      toast(n ? `已从云端拉取 ${n} 个项目` : '云端没有新项目', n ? 'ok' : 'info');
    } catch (e) {
      toast(`拉取失败：${(e as Error).message}`, 'err');
    }
  };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '26px 22px 60px' }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>🃏 CardArts</h1>
          <div className="muted small">本地优先的卡牌设计工具 · 数据默认存在你的浏览器里</div>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={onPull}>从云端拉取</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>导入项目</button>
        <button className="btn primary" onClick={() => setShowNew(true)}>+ 新建项目</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.cardarts,application/json"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }}
        />
      </div>

      {!projects ? (
        <div className="muted">加载中…</div>
      ) : projects.length === 0 ? (
        <div className="card">
          <Empty
            icon="🃏"
            text="还没有项目，新建一个开始设计你的卡牌吧"
            action={<button className="btn primary" onClick={() => setShowNew(true)}>+ 新建项目</button>}
          />
        </div>
      ) : (
        <div className="projects">
          {projects.map((p) => {
            const s = stats(p.content);
            return (
              <div key={p.id} className="proj" onClick={() => navigate(`p/${p.id}/cards`)}>
                <div className="nm">{p.name}</div>
                <div className="meta">
                  <span>🎴 {s.decks} 牌组</span>
                  <span>🗂 {s.cards} 卡牌</span>
                  <span>📝 {s.docs} 文档</span>
                </div>
                <div className="small faint">更新于 {formatDate(p.updatedAt)}{p.dirty ? ' · 待同步' : ''}</div>
                <div className="acts" onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => navigate(`p/${p.id}/editor`)}>编辑版式</button>
                  <button className="btn sm" onClick={() => void duplicate(p.id)}>副本</button>
                  <button className="btn sm" onClick={() => void onBackup(p.id)}>备份</button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      const ok = await ask({ title: '删除项目', text: `确定删除「${p.name}」？本地数据将不可恢复。`, danger: true });
                      if (ok) { await remove(p.id); toast('已删除'); }
                    }}
                  >删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <WorkspaceCard />

      <div className="card mt16">
        <div className="hd">关于本地优先</div>
        <div className="bd small muted" style={{ lineHeight: 1.8 }}>
          <div>· 项目内容保存在浏览器 IndexedDB，<b>离线可正常编辑</b>；联网后自动增量同步到后端。</div>
          <div>· 素材走内容寻址存储（sha256），相同文件只存一份；支持秒传 / 分片 / 断点续传。</div>
          <div>· 内置 4239 个 game-icons.net 图标（CC BY 3.0），可直接预览并加入自建素材库。</div>
          <div>· 任何时候都可以从「导出中心」导出完整备份 <span className="mono">.cardarts.json</span>。</div>
        </div>
      </div>

      {showNew && (
        <Modal
          title="新建项目"
          onClose={() => setShowNew(false)}
          footer={<button className="btn" onClick={() => setShowNew(false)}>取消</button>}
        >
          <div className="field">
            <label className="lbl">项目名称</label>
            <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：奇幻对战卡牌" />
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void onCreate('blank')}>空白项目</button>
            <button className="btn" onClick={() => void onCreate('demo')}>从示例工程开始</button>
          </div>
          <div className="small faint mt8">示例工程包含 3 张卡牌、完整版式与一张牌背，可直接预览与导出。</div>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}

void api; void formatBytes;
