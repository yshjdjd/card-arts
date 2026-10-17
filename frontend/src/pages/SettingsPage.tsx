import React, { useState } from 'react';
import { useProject, useApp, navigate } from '../state/store';
import { useToast, useConfirm, Modal, Select, Field as F } from '../components/ui';
import { t, setLang, getLang } from '../lib/i18n';
import { db } from '../db/schema';
import { flush } from '../db/sync';
import WorkspaceCard from '../features/WorkspaceCard';

export default function SettingsPage() {
  const { content, project, update, rename } = useProject();
  const { theme, setTheme } = useApp();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const [name, setName] = useState(project?.name ?? '');
  const [lang, setLangState] = useState(getLang());
  const [showMcp, setShowMcp] = useState(false);

  const settings = (content.settings ?? {}) as Record<string, unknown>;

  const setSetting = (k: string, v: unknown) =>
    update((c) => { const s = (c.settings ??= {}); s[k] = v; }, '修改设置');

  const onDelete = async () => {
    const ok = await ask({
      title: '删除项目',
      text: `确定删除「${project?.name}」？本地数据不可恢复，建议先做一次备份。`,
      danger: true,
    });
    if (!ok) return;
    await db.projects.delete(project!.id);
    toast('已删除');
    navigate('');
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="card">
        <div className="hd">项目</div>
        <div className="bd">
          <F label="项目名称">
            <div className="row">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" onClick={() => void rename(name)}>保存</button>
            </div>
          </F>
          <div className="row">
            <span className="small muted">项目 id</span>
            <span className="small mono faint">{project?.id}</span>
          </div>
          <div className="row">
            <span className="small muted">服务端 id</span>
            <span className="small mono faint">{project?.remoteId ?? '（尚未同步）'}</span>
          </div>
          <div className="row">
            <span className="small muted">本地 revision</span>
            <span className="small mono faint">{project?.localRevision}</span>
            <span className="small muted">基准 revision</span>
            <span className="small mono faint">{project?.baseRevision}</span>
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="hd">界面</div>
        <div className="bd">
          <F label="语言">
            <Select
              value={lang}
              onChange={(v) => { setLang(v); setLangState(v); }}
              options={[{ value: 'zh', label: '简体中文' }, { value: 'en', label: 'English' }]}
            />
          </F>
          <F label="主题">
            <Select
              value={theme}
              onChange={setTheme}
              options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
            />
          </F>
          <div className="small faint">{t('app.tagline')}</div>
        </div>
      </div>

      <div className="card mt16">
        <div className="hd">同步</div>
        <div className="bd">
          <label className="row small" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.syncEnabled !== false}
              onChange={(e) => void setSetting('syncEnabled', e.target.checked)}
            />
            启用自动同步（每 15 秒回放一次待推送队列）
          </label>
          <div className="row mt8">
            <button className="btn" onClick={() => void flush().then(() => toast('已同步', 'ok')).catch(() => toast('同步失败', 'err'))}>
              立即同步
            </button>
            <button className="btn" onClick={() => setShowMcp(true)}>MCP 接入说明</button>
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="hd">本地文件夹</div>
        <div className="bd">
          <WorkspaceCard dense />
          <div className="small faint mt8">
            服务端数据库与素材对象存储位于 <span className="mono">card_arts/data/</span>，
            可用环境变量 <span className="mono">CARDARTS_DATA_DIR</span> 改到别处。
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="hd">危险操作</div>
        <div className="bd">
          <button className="btn danger" onClick={() => void onDelete()}>删除当前项目</button>
          <div className="small faint mt8">删除前建议先到「导出中心」做一次完整备份。</div>
        </div>
      </div>

      {showMcp && (
        <Modal
          title="MCP 接入说明"
          wide
          onClose={() => setShowMcp(false)}
          footer={<button className="btn" onClick={() => setShowMcp(false)}>关闭</button>}
        >
          <div className="small" style={{ lineHeight: 1.9 }}>
            <div>后端内置了一个 MCP Server，Claude Desktop / Cursor 等客户端可以直接连上来改工程：</div>
            <pre className="mono" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, overflow: 'auto' }}>
{`# stdio（推荐）
cd card_arts/backend
python -m app.mcp.server

# 或 HTTP
MCP_TRANSPORT=streamable-http MCP_PORT=8765 python -m app.mcp.server`}
            </pre>
            <div>客户端配置示例：</div>
            <pre className="mono" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, overflow: 'auto' }}>
{`{
  "mcpServers": {
    "cardarts": {
      "command": "python",
      "args": ["-m", "app.mcp.server"],
      "cwd": "D:/workbuddy_pro/2026-10-16-19-15-55/card_arts/backend"
    }
  }
}`}
            </pre>
            <div>提供的能力：项目索引 Resource、工程概览 Resource、21 个工具（建牌组 / 改字段 / 批量写卡牌 / 搜图标 / 改版式 / 上传素材等）、2 个 Prompt 模板。</div>
          </div>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}
