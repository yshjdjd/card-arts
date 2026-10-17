import React, { useEffect, useRef, useState } from 'react';
import { useAssets, useProject } from '../state/store';
import { useToast } from '../components/ui';
import { Uploader } from '../api/uploader';
import { db } from '../db/schema';
import { uid } from '../lib/utils';
import { FONTS, fontCss } from '../lib/presets';
import { fontKey } from '../lib/fontIdentity';
import { expandFontFiles, projectFontSources } from '../lib/projectFonts';
import { loadFontSources } from '../lib/fontRuntime';
import type { Layout } from '../lib/types';

export default function FontsPage() {
  const { project, content, update } = useProject();
  const { assets, remoteId, refresh, deleteAsset } = useAssets();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const fonts = assets.filter((a) => a.kind === 'font');
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState('卡牌设计：烈焰冲击 Aa 123');
  const [fontError, setFontError] = useState('');
  const [ready, setReady] = useState(false);
  const key = String(content.settings?.defaultFont || 'sans');
  useEffect(() => {
    let alive = true;
    setReady(false); setFontError('');
    const layout = { elements: fonts.map((a) => ({ fontFamily: fontKey(a.id) })) } as Layout;
    projectFontSources([layout], assets).then(loadFontSources).then(() => { if (alive) setReady(true); })
      .catch((error) => { if (alive) setFontError((error as Error).message); });
    return () => { alive = false; };
  }, [assets]);
  const importFiles = async (list: FileList | null) => {
    if (!list?.length || !project || busy) return;
    setBusy(true);
    try {
      const files = await expandFontFiles(Array.from(list));
      let remote = '';
      try { remote = await remoteId(); } catch { /* local-first */ }
      for (const file of files) {
        if (remote) await Uploader.upload(file, { projectId: remote });
        else {
          const id = uid();
          await db.assets.put({ id, projectId: project.id, name: file.name, kind: 'font', mime: file.type, size: file.size,
            sha256: '', blob: file, state: 'local-only', createdAt: new Date().toISOString() });
          await db.outbox.add({ projectId: project.id, op: 'upload-asset', payload: { assetId: id }, createdAt: new Date().toISOString(), attempts: 0 });
        }
      }
      toast(`已添加 ${files.length} 个字体，可在文字属性中选择`, 'ok');
    } catch (error) { toast((error as Error).message, 'err'); }
    finally { await refresh(); setBusy(false); }
  };
  const applyAll = async () => {
    await update((c) => {
      for (const deck of c.decks) for (const layout of [deck.frontLayout, deck.backLayout]) {
        for (const el of layout?.elements || []) if (el.kind === 'text') el.fontFamily = key;
      }
    }, '统一项目字体');
    toast('已应用到全部牌组正反面的文字；可撤销', 'ok');
  };
  return <div className="card">
    <div className="hd"><b style={{ flex: 1 }}>项目字体库</b><button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? '导入中…' : '添加字体 / ZIP 字体包'}</button></div>
    <div className="bd">
      <input ref={input} type="file" multiple accept=".ttf,.otf,.woff,.woff2,.zip" hidden onChange={(e) => { void importFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <p className="small muted">支持 TTF、OTF、WOFF、WOFF2；ZIP 内可包含多个字体。字体会用于卡牌预览、打印和导出。</p>
      <div className="row wrap">
        <label>新建文字默认字体</label>
        <select className="select" value={key} onChange={(e) => { const value = e.currentTarget.value; void update((c) => { (c.settings ??= {}).defaultFont = value; }, '设置默认字体'); }}>
          {FONTS.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
          {fonts.map((a) => <option key={a.id} value={fontKey(a.id)}>{a.name}</option>)}
        </select>
        <button className="btn" onClick={() => void applyAll()}>应用到全部现有文字</button>
      </div>
      <input className="input mt16" aria-label="字体预览文字" value={sample} onChange={(e) => setSample(e.currentTarget.value)} />
      {fontError && <p className="danger">字体加载失败：{fontError}。请检查素材文件，不能据此预览确认字体效果。</p>}
      {!ready && fonts.length > 0 && !fontError && <p>正在加载字体…</p>}
      <div className="grid-assets mt16">
        {[...FONTS.map((f) => ({ id: f.key, name: f.name, key: f.key, custom: false })), ...fonts.map((a) => ({ id: a.id, name: a.name, key: fontKey(a.id), custom: true }))].map((f) =>
          <div className="card bd" key={f.id}>
            <b>{f.name}</b><div style={{ fontFamily: fontCss(f.key), fontSize: 27, padding: '18px 0' }}>{sample}</div>
            <div className="row"><button className="btn sm" onClick={() => void update((c) => { (c.settings ??= {}).defaultFont = f.key; }, '设置默认字体')}>设为默认</button>
              {f.custom && <button className="btn sm ghost" onClick={async () => {
                const used = content.decks.some((d) => [d.frontLayout, d.backLayout].some((l) => l?.elements.some((el) => el.fontFamily === f.key)));
                if (used || key === f.key) { toast('字体正在使用，请先替换引用后再删除', 'err'); return; }
                await deleteAsset(f.id);
              }}>删除</button>}
            </div>
          </div>)}
      </div>
    </div>
  </div>;
}
