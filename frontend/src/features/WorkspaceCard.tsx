import React, { useState } from 'react';
import { useApp } from '../state/store';
import { useToast } from '../components/ui';
import { suggestedPath } from '../db/workspace';
import { formatDate } from '../lib/utils';

/**
 * 「本地文件夹工作区」卡片：把项目 / 素材 / 版本写成工作目录下的真实文件。
 * 需要 Chromium 内核浏览器（Chrome / Edge / QQ 浏览器）的 File System Access API。
 */
export default function WorkspaceCard({ dense = false }: { dense?: boolean }) {
  const {
    workspace, workspaceSupported,
    connectWorkspace, disconnectWorkspace, reauthorizeWorkspace,
    mirrorNow, importFromWorkspace,
  } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const onConnect = async () => {
    setBusy(true);
    try {
      await connectWorkspace();
      toast(`已连接文件夹「${workspace.name || '工作区'}」，项目 / 素材 / 版本已写入`, 'ok');
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/abort/i.test(msg)) toast(`连接失败：${msg}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const onReauth = async () => {
    setBusy(true);
    try {
      const ok = await reauthorizeWorkspace();
      toast(ok ? '已重新获得文件夹权限' : '授权被拒绝', ok ? 'ok' : 'err');
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    await disconnectWorkspace();
    toast('已断开文件夹工作区（文件保留在磁盘上）');
  };

  const onMirror = async () => {
    setBusy(true);
    try {
      const r = await mirrorNow();
      toast(`已写入 ${r.files} 个文件（项目 ${r.projects} · 素材 ${r.assets} · 版本 ${r.versions}）`, 'ok');
    } catch (e) {
      toast(`写盘失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    try {
      const r = await importFromWorkspace();
      toast(r.projects || r.assets ? `已从文件夹恢复 ${r.projects} 个项目、${r.assets} 个素材` : '文件夹里没有可恢复的项目', r.projects ? 'ok' : 'info');
    } catch (e) {
      toast(`恢复失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceSupported) {
    return (
      <div className="card">
        <div className="hd">本地文件夹工作区</div>
        <div className="bd small muted">
          当前浏览器不支持 File System Access API，无法直接读写真实文件夹。
          请使用 Chrome / Edge / QQ 浏览器等 Chromium 内核浏览器；
          其它浏览器可用「导出中心」的完整备份 <span className="mono">.cardarts.json</span> 代替。
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="hd">本地文件夹工作区</div>
      <div className="bd">
        <div className="row">
          <span className="small muted">状态</span>
          {workspace.connected
            ? <span className="tag ok">已连接 · {workspace.name}</span>
            : workspace.name
              ? <span className="tag gray">{workspace.name}（需重新授权）</span>
              : <span className="tag gray">未连接</span>}
          {workspace.writing && <span className="tag">⏳ 写盘中…</span>}
        </div>

        {workspace.connected && (
          <div className="row mt8 small muted">
            <span>最近落盘</span>
            <span className="mono faint">{workspace.lastSyncAt ? formatDate(workspace.lastSyncAt) : '—'}</span>
            <span>写入文件</span>
            <span className="mono faint">{workspace.files}</span>
          </div>
        )}

        <div className="row mt8">
          {!workspace.connected && (
            <button className="btn primary" disabled={busy} onClick={() => void onConnect()}>
              连接文件夹…
            </button>
          )}
          {!workspace.connected && workspace.name && (
            <button className="btn" disabled={busy} onClick={() => void onReauth()}>重新授权</button>
          )}
          {workspace.connected && (
            <>
              <button className="btn" disabled={busy} onClick={() => void onMirror()}>立即落盘</button>
              <button className="btn" disabled={busy} onClick={() => void onImport()}>从文件夹恢复</button>
              <button className="btn ghost" disabled={busy} onClick={() => void onDisconnect()}>断开</button>
            </>
          )}
        </div>

        {!dense && (
          <div className="small faint mt8" style={{ lineHeight: 1.8 }}>
            <div>建议选择 <span className="mono">{suggestedPath()}</span> 作为工作区目录，写入后的结构：</div>
            <pre className="mono" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, overflow: 'auto', marginTop: 6 }}>
{`cardarts.json                     索引清单
projects/{名称}-{id}.json          项目全文（牌组 / 卡牌 / 版式 / 文档）
assets/{文件夹}/{文件名}            素材原文件，按界面里的文件夹树直存
assets/.assets.json               素材元数据（id / sha256 / 尺寸 / 主色）
versions/{项目}/{序号}-{标签}.json   最近 30 条版本快照`}
            </pre>
            <div className="mt8">· 运行时仍以 IndexedDB 为主（快、支持事务），文件夹是它的持久化镜像，改动后约 1 秒自动写回。</div>
            <div>· 清缓存或换机器后，重新连接同一目录并点「从文件夹恢复」即可把数据读回来。</div>
          </div>
        )}
      </div>
    </div>
  );
}
