import React, { useCallback, useEffect, useState } from 'react';
import { useProject } from '../state/store';
import { useToast, useConfirm, Empty, Modal } from '../components/ui';
import { api, type VersionDTO } from '../api/client';
import { formatBytes, formatDate } from '../lib/utils';
import { db } from '../db/schema';

export default function VersionsPage() {
  const { content, project, update } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const [items, setItems] = useState<VersionDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [offline, setOffline] = useState(false);

  const remoteId = project?.remoteId;

  const load = useCallback(async () => {
    if (!remoteId) { setOffline(true); return; }
    setLoading(true);
    try {
      const r = await api.listVersions(remoteId);
      setItems(r.items ?? []);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [remoteId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!remoteId) { toast('项目还没同步到服务端，先点一次「立即同步」', 'err'); return; }
    try {
      const p = await db.projects.get(project!.id);
      await api.saveVersion(remoteId, name.trim() || `版本 ${new Date().toLocaleString('zh-CN')}`, p?.content ?? content);
      setShowSave(false);
      setName('');
      await load();
      toast('已保存版本', 'ok');
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, 'err');
    }
  };

  const restore = async (v: VersionDTO) => {
    if (!remoteId) return;
    const ok = await ask({
      title: '恢复版本',
      text: `确定恢复到「${v.name}」？当前未保存的内容会被覆盖（系统会自动留一个撤销点）。`,
    });
    if (!ok) return;
    try {
      const res = await api.restoreVersion(remoteId, v.id);
      await update((c) => { void c; }, '恢复版本前快照');
      await db.projects.update(project!.id, {
        content: res.content as typeof content,
        baseRevision: res.revision,
        dirty: false,
      });
      await load();
      toast('已恢复（Ctrl 撤销可用一次）', 'ok');
    } catch (e) {
      toast(`恢复失败：${(e as Error).message}`, 'err');
    }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="card">
        <div className="hd">
          <span style={{ flex: 1 }}>服务端版本快照</span>
          <button className="btn sm" onClick={() => void load()}>刷新</button>
          <button className="btn sm primary" onClick={() => setShowSave(true)}>保存当前版本</button>
        </div>
        <div className="bd">
          {offline ? (
            <Empty
              icon="☁️"
              text={remoteId ? '暂时无法连接服务端' : '项目还没有同步到服务端'}
            />
          ) : loading ? (
            <div className="muted small">加载中…</div>
          ) : items.length === 0 ? (
            <Empty icon="🕘" text="还没有版本快照，先保存一个吧" />
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>名称</th><th style={{ width: 90 }}>基准</th><th style={{ width: 110 }}>大小</th><th style={{ width: 170 }}>时间</th><th style={{ width: 90 }}>操作</th></tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>{v.name}</td>
                    <td className="small faint">r{v.base_revision}</td>
                    <td className="small">{v.size_bytes ? formatBytes(v.size_bytes) : '—'}</td>
                    <td className="small muted">{formatDate(v.created_at)}</td>
                    <td><button className="btn sm" onClick={() => void restore(v)}>恢复</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ft small faint">
          版本快照存在服务端，是除「本地撤销」之外的第二道保险；重大改动前建议先存一个。
        </div>
      </div>

      {showSave && (
        <Modal
          title="保存版本快照"
          onClose={() => setShowSave(false)}
          footer={<><button className="btn" onClick={() => setShowSave(false)}>取消</button><button className="btn primary" onClick={() => void save()}>保存</button></>}
        >
          <div className="field">
            <label className="lbl">版本名称</label>
            <input
              className="input" autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`版本 ${new Date().toLocaleString('zh-CN')}`}
            />
          </div>
          <div className="small faint">留空则使用当前时间命名。快照包含牌组、字段、卡牌与文档。</div>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}
