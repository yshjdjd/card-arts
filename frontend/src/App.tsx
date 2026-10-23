import React, { useEffect, useRef, useState } from 'react';
import { AppProvider, AssetsProvider, ProjectProvider, useApp, useRoute, useProject } from './state/store';
import { ToastProvider } from './components/ui';
import Dashboard from './pages/Dashboard';
import CardsPage from './pages/CardsPage';
import DecksPage from './pages/DecksPage';
import EditorPage from './pages/EditorPage';
import AssetsPage from './pages/AssetsPage';
import IconLibraryPage from './pages/IconLibraryPage';
import FontsPage from './pages/FontsPage';
import DocumentsPage from './pages/DocumentsPage';
import VersionsPage from './pages/VersionsPage';
import ExportPage from './pages/ExportPage';
import SettingsPage from './pages/SettingsPage';
import PrintPage from './pages/PrintPage';
import AgentChat from './features/AgentChat';
import { t } from './lib/i18n';

const NAV = [
  { key: 'cards', label: '卡牌数据', icon: '🗂' },
  { key: 'decks', label: '牌组与字段', icon: '🎴' },
  { key: 'editor', label: '版式编辑器', icon: '✏️' },
  { key: 'assets', label: '素材库', icon: '🖼' },
  { key: 'icons', label: '内置图标库', icon: '✨' },
  { key: 'fonts', label: '字体库', icon: '🔤' },
  { key: 'documents', label: '项目文档', icon: '📝' },
  { key: 'export', label: '导出中心', icon: '📦' },
  { key: 'versions', label: '版本历史', icon: '🕘' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

function Sidebar({ projectId, tab, onOpenAgent }: { projectId: string; tab: string; onOpenAgent: () => void }) {
  const { project } = useProject();
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">🃏</span>
        <span>CardArts</span>
      </div>
      <div>
        <div className="sec">项目</div>
        <a className="nav" href="#/">← 全部项目</a>
        <div className="small" style={{ padding: '4px 20px 10px', color: '#8b93a1' }}>
          {project?.name ?? '加载中…'}
        </div>
        <div className="sec">工作区</div>
        {NAV.map((n) => (
          <a
            key={n.key}
            className={`nav ${tab === n.key ? 'active' : ''}`}
            href={`#/p/${projectId}/${n.key}`}
          >
            <span className="ico">{n.icon}</span>
            <span>{n.label}</span>
          </a>
        ))}
        <button className="nav" style={{ width: 'auto', background: 'transparent', border: 0 }} onClick={onOpenAgent}>
          <span className="ico">🤖</span>
          <span>Agent辅助</span>
        </button>
      </div>
      <div className="foot">
        <div>本地优先 · 数据存在你的浏览器</div>
        <div style={{ marginTop: 4 }}>图标来自 game-icons.net (CC BY 3.0)</div>
      </div>
    </aside>
  );
}

function TopBar({ children }: { children?: React.ReactNode }) {
  const { syncState, online, theme, setTheme, syncNow, workspace, workspaceSupported } = useApp();
  const { project, undo, redo, canUndo, canRedo } = useProject();
  const [busy, setBusy] = useState(false);

  const doSync = async () => {
    setBusy(true);
    try { await syncNow(); } finally { setBusy(false); }
  };

  const badge =
    syncState === 'syncing' ? <span className="tag">同步中…</span>
      : syncState === 'error' ? <span className="tag err">同步失败</span>
        : online ? <span className="tag ok">{t('common.online')}</span>
          : <span className="tag gray">{t('common.offline')}</span>;

  return (
    <div className="topbar">
      <span className="title">{project?.name ?? ''}</span>
      {children}
      <span className="spacer" />
      {workspaceSupported && (
        <span
          className={`tag ${workspace.connected ? 'ok' : 'gray'}`}
          title={workspace.connected ? `已连接文件夹工作区：${workspace.name}` : '未连接本地文件夹工作区'}
        >
          {workspace.writing ? '⏳ 写盘…' : workspace.connected ? `📁 ${workspace.name}` : '📁 未连接'}
        </span>
      )}
      <button className="btn sm" disabled={!canUndo} onClick={() => void undo()} title="撤销">↶ 撤销</button>
      <button className="btn sm" disabled={!canRedo} onClick={() => void redo()} title="重做">↷ 重做</button>
      {badge}
      <button className="btn sm" onClick={doSync} disabled={busy}>{busy ? '同步…' : '立即同步'}</button>
      <button
        className="btn sm ghost"
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        title="切换主题"
      >
        {theme === 'light' ? '🌙' : '☀️'}
      </button>
    </div>
  );
}

function ProjectBody({ projectId, tab }: { projectId: string; tab: string }) {
  switch (tab) {
    case 'decks': return <DecksPage />;
    case 'editor': return <EditorPage />;
    case 'assets': return <AssetsPage />;
    case 'icons': return <IconLibraryPage />;
    case 'fonts': return <FontsPage />;
    case 'documents': return <DocumentsPage />;
    case 'export': return <ExportPage />;
    case 'versions': return <VersionsPage />;
    case 'settings': return <SettingsPage />;
    default: return <CardsPage />;
  }
}

/** 右下角悬浮按钮：默认固定右下角，按住可拖到屏幕大部分区域任意位置；轻点切换开合。 */
function DraggableFab({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ active: boolean; dx: number; dy: number; moved: boolean }>({
    active: false, dx: 0, dy: 0, moved: false,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { active: true, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag.current.active) return;
    const nx = Math.min(Math.max(8, e.clientX - drag.current.dx), window.innerWidth - 54);
    const ny = Math.min(Math.max(8, e.clientY - drag.current.dy), window.innerHeight - 54);
    if (nx !== (pos?.x ?? -1) || ny !== (pos?.y ?? -1)) drag.current.moved = true;
    setPos({ x: nx, y: ny });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const wasMoved = drag.current.moved;
    drag.current.active = false;
    if (!wasMoved) onToggle();
  };

  return (
    <button
      className="chat-fab"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title="AI 助手 (Ctrl+K) · 按住拖动"
    >
      {open ? '✕' : '🤖'}
    </button>
  );
}

function Shell() {
  const route = useRoute();
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (route.name === 'print' && route.projectId) {
    return (
      <ProjectProvider projectId={route.projectId}>
        <AssetsProvider projectId={route.projectId}>
          <PrintPage />
        </AssetsProvider>
      </ProjectProvider>
    );
  }

  if (route.name === 'project' && route.projectId) {
    const tab = route.tab ?? 'cards';
    return (
      <ProjectProvider projectId={route.projectId}>
        <AssetsProvider projectId={route.projectId}>
          <div className="app">
            <Sidebar projectId={route.projectId} tab={tab} onOpenAgent={() => setChatOpen(true)} />
            <div className="main">
              <TopBar />
              <div className={`content ${tab === 'editor' ? 'flush' : ''}`}>
                <ProjectBody projectId={route.projectId} tab={tab} />
              </div>
            </div>
          </div>
          <DraggableFab open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
          {chatOpen && <AgentChat onClose={() => setChatOpen(false)} />}
        </AssetsProvider>
      </ProjectProvider>
    );
  }

  return <Dashboard />;
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AppProvider>
  );
}
