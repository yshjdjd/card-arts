import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useProject } from '../state/store';
import { useToast, useConfirm, Empty } from '../components/ui';
import type { ProjectDocument, TableData } from '../lib/types';
import { formatDate, uid } from '../lib/utils';
import { tableToMarkdown } from '../lib/agentTools';
import { applyDocumentPatch, DocumentDrafts } from '../lib/documentDrafts';
import { exportTableCSV, exportTableXLSX, flattenSheets, parseCSV, readXLSX } from '../lib/table';

/** 极简 Markdown 渲染：够写设计说明用，不引第三方依赖 */
function md(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = src.split('\n');
  const out: string[] = [];
  let inList = false;
  let inTable = false;

  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  /** Markdown 表格：| 表头 | ... | --- | ... | 数据行 | */
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string): string[] =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isTableRow(line)) {
      closeList();
      const cs = cells(line);
      const isSep = cs.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSep) continue;
      if (!inTable) {
        out.push('<table class="mdtable"><thead><tr>' + cs.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>' + cs.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }
    closeTable();
    if (/^\s*(-|\*|\d+\.)\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*(-|\*|\d+\.)\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (/^#{1,6}\s/.test(line)) {
      const lv = line.match(/^#+/)![0].length;
      out.push(`<h${lv}>${inline(line.replace(/^#+\s/, ''))}</h${lv}>`);
    } else if (/^(---|\*\*\*)\s*$/.test(line)) {
      out.push('<hr/>');
    } else if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (line.trim() === '') {
      out.push('<div style="height:8px"></div>');
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  closeTable();
  return out.join('');
}

const MAX_RENDER_ROWS = 300;

export default function DocumentsPage() {
  const { content, update } = useProject();
  const toast = useToast();
  const [confirmNode, ask] = useConfirm();
  const docs = content.documents ?? [];
  const [activeId, setActiveId] = useState(docs[0]?.id ?? '');
  const storedActive = docs.find((d) => d.id === activeId) ?? docs[0];
  const drafts = useMemo(() => new DocumentDrafts(async (id, changes) => {
    await update((c) => {
      const doc = c.documents.find((d) => d.id === id);
      if (!doc) throw new Error('文档已被删除，草稿未保存');
      applyDocumentPatch(doc, changes);
      if (doc.kind === 'table' && doc.table) doc.content = tableToMarkdown(doc.table);
      doc.updatedAt = new Date().toISOString();
    }, '编辑文档');
  }), [update]);
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  useEffect(() => { drafts.reconcile(docs); }, [drafts, docs]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (drafts.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', leaving);
    return () => { window.removeEventListener('beforeunload', leaving); void drafts.flushAll(); };
  }, [drafts]);
  const active = storedActive ? drafts.view(storedActive) : undefined;
  const [tab, setTab] = useState<'edit' | 'split' | 'view'>('split');
  const fileRef = useRef<HTMLInputElement>(null);
  const [tablePage, setTablePage] = useState(0);
  useEffect(() => { setTablePage(0); }, [active?.id]);

  const isTable = active?.kind === 'table';
  const html = useMemo(() => (active ? md(isTable ? tableToMarkdown(active.table!) : active.content) : ''), [active, isTable]);

  const save = async () => {
    if (!active) return true;
    const success = await drafts.flush(active.id);
    if (!success) toast(drafts.error(active.id) || '请完成输入后再保存', 'err');
    return success;
  };
  const selectDocument = async (id: string) => { if (await save()) setActiveId(id); };
  const patch = async (fn: (d: ProjectDocument) => void, label = '编辑文档') => {
    const id = active?.id;
    if (!id || !await save()) return;
    await update((c) => {
      const doc = c.documents.find((d) => d.id === id);
      if (doc) { fn(doc); doc.updatedAt = new Date().toISOString(); }
    }, label);
  };
  const blur = () => {
    if (active) { drafts.pause(active.id, false); void save(); }
  };

  const add = async (kind: 'markdown' | 'table' = 'markdown') => {
    if (!await save()) return;
    const id = uid();
    const now = new Date().toISOString();
    await update((c) => {
      c.documents ??= [];
      c.documents.push(kind === 'table'
        ? {
          id, title: '新表格', kind: 'table', content: '',
          table: { header: ['列1', '列2'], rows: [['', ''], ['', '']] },
          createdAt: now, updatedAt: now,
        }
        : { id, title: '新文档', content: '# 新文档\n\n', createdAt: now, updatedAt: now });
    }, '新增文档');
    setActiveId(id);
  };

  const del = async (id: string, title: string) => {
    const ok = await ask({ title: '删除文档', text: `确定删除「${title}」？`, danger: true });
    if (!ok) return;
    if (!await drafts.flush(id)) { toast('文档尚未保存，请先重试保存', 'err'); return; }
    await update((c) => { c.documents = c.documents.filter((d) => d.id !== id); }, '删除文档');
    drafts.discard(id);
    setActiveId('');
    toast('已删除');
  };

  /* ---------------- 导入结构化数据 ---------------- */

  const importFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const made: { title: string; kind: 'markdown' | 'table'; content: string; table?: TableData }[] = [];

    for (const f of Array.from(fileList)) {
      const name = f.name.toLowerCase();
      try {
        if (/\.(xlsx|xlsm|xls)$/.test(name)) {
          const sheets = flattenSheets(await readXLSX(f));
          if (!sheets.length) { toast(`${f.name}：没有读到数据`, 'err'); continue; }
          const base = f.name.replace(/\.(xlsx|xlsm|xls)$/i, '');
          for (const s of sheets) {
            const t: TableData = { header: s.header, rows: s.rows, sheet: s.name };
            made.push({
              title: sheets.length > 1 ? `${base} · ${s.name}` : base,
              kind: 'table', content: tableToMarkdown(t), table: t,
            });
          }
        } else if (/\.csv$/.test(name)) {
          const rows = parseCSV(await f.text()).filter((r) => r.some((c) => c.trim() !== ''));
          if (rows.length < 1) { toast(`${f.name}：空文件`, 'err'); continue; }
          const header = rows[0].map((h, i) => h.trim() || `列${i + 1}`);
          const t: TableData = { header, rows: rows.slice(1).map((r) => header.map((_, i) => r[i] ?? '')) };
          made.push({
            title: f.name.replace(/\.csv$/i, ''), kind: 'table',
            content: tableToMarkdown(t), table: t,
          });
        } else if (/\.json$/.test(name)) {
          const j = JSON.parse(await f.text());
          const list: unknown[] | null = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : null;
          if (!list?.length) { toast(`${f.name}：不是数组，已跳过`, 'err'); continue; }
          const objs = list.filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object' && !Array.isArray(o));
          const header = [...new Set(objs.flatMap((o) => Object.keys(o)))];
          const rows: string[][] = objs.map((o) => header.map((h) => String(o[h] ?? '')));
          const t: TableData = { header, rows };
          made.push({ title: f.name.replace(/\.json$/i, ''), kind: 'table', content: tableToMarkdown(t), table: t });
        } else if (/\.(md|markdown|txt)$/.test(name)) {
          made.push({ title: f.name.replace(/\.(md|markdown|txt)$/i, ''), kind: 'markdown', content: await f.text() });
        } else {
          toast(`不支持的文件类型：${f.name}`, 'err');
        }
      } catch (e) {
        toast(`${f.name} 导入失败：${(e as Error).message}`, 'err');
      }
    }

    if (!made.length || !await save()) return;
    const now = new Date().toISOString();
    let firstId = '';
    await update((c) => {
      c.documents ??= [];
      for (const m of made) {
        const id = uid();
        if (!firstId) firstId = id;
        c.documents.push({
          id, title: m.title, kind: m.kind, content: m.content, table: m.table,
          source: { name: m.title, size: 0, importedAt: now },
          createdAt: now, updatedAt: now,
        });
      }
    }, `导入 ${made.length} 篇文档`);
    setActiveId(firstId);
    toast(`已导入 ${made.length} 篇文档`);
  };

  /* ---------------- 表格编辑 ---------------- */

  const table = active?.table;
  const rowsView = table?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rowsView.length / MAX_RENDER_ROWS));
  const page = Math.min(tablePage, pageCount - 1);
  const rowStart = page * MAX_RENDER_ROWS;

  const addRow = () => patch((d) => {
    if (!d.table) return;
    d.table.rows.push(d.table.header.map(() => ''));
    d.content = tableToMarkdown(d.table);
    d.updatedAt = new Date().toISOString();
  }, '表格加行');

  const addCol = () => patch((d) => {
    if (!d.table) return;
    const n = d.table.header.length + 1;
    d.table.header.push(`列${n}`);
    d.table.rows.forEach((r) => r.push(''));
    d.content = tableToMarkdown(d.table);
    d.updatedAt = new Date().toISOString();
  }, '表格加列');

  const delRow = (ri: number) => patch((d) => {
    if (!d.table) return;
    d.table.rows.splice(ri, 1);
    d.content = tableToMarkdown(d.table);
    d.updatedAt = new Date().toISOString();
  }, '表格删行');

  return (
    <div className="grid2" style={{ gridTemplateColumns: '260px 1fr', alignItems: 'start', height: '100%' }} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    }}>
      <div className="card">
        <div className="hd">
          <span style={{ flex: 1 }}>文档</span>
          <button className="btn sm" onClick={() => fileRef.current?.click()} title="导入 xlsx / xls / csv / json / md">⬆ 导入</button>
          <button className="btn sm primary" onClick={() => add('markdown')}>+ 新建</button>
        </div>
        <div className="bd" style={{ padding: 8 }}>
          {docs.length === 0 && <div className="small faint" style={{ padding: 8 }}>还没有文档</div>}
          {docs.map((d) => (
            <div key={d.id} className={`folder-item ${d.id === active?.id ? 'on' : ''}`} onClick={() => void selectDocument(d.id)}>
              <span>{d.kind === 'table' ? '📊' : '📝'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
              {d.kind === 'table' && <span className="small faint">{d.table?.rows.length ?? 0}行</span>}
              <button className="iconbtn" onClick={(e) => { e.stopPropagation(); void del(d.id, d.title); }}>🗑</button>
            </div>
          ))}
        </div>
        <div className="ft small faint">
          可导入 .xlsx / .xls / .csv / .json / .md；表格文档能被助手精确读写
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".xlsx,.xlsm,.xls,.csv,.json,.md,.markdown,.txt"
        style={{ display: 'none' }}
        onChange={(e) => { void importFiles(e.target.files); e.target.value = ''; }}
      />

      {!active ? (
        <div className="card">
          <Empty icon="📝" text="选择或新建一篇文档" action={<button className="btn primary" onClick={() => add('markdown')}>+ 新建文档</button>} />
        </div>
      ) : (
        <div key={active.id} className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 480 }}>
          <div className="hd">
            <input
              className="input" style={{ width: 220, fontWeight: 600 }}
              value={active.title}
              onChange={(e) => drafts.edit(active.id, { title: e.currentTarget.value })}
              onBlur={blur}
              onCompositionStart={() => drafts.pause(active.id, true)}
              onCompositionEnd={() => drafts.pause(active.id, false)}
            />
            <span className="small faint">{isTable ? '表格' : 'Markdown'}</span>
            <span className="small" role="status" title={drafts.error(active.id)}>
              {{ saved: '已保存到本地', pending: '有未保存修改', saving: '保存中…', error: '保存失败，草稿已保留' }[drafts.status(active.id)]}
            </span>
            <button className="btn sm" onClick={() => void save()}>保存</button>
            <span style={{ flex: 1 }} />
            {isTable ? (
              <>
                <button className="btn sm" onClick={addRow}>+ 行</button>
                <button className="btn sm" onClick={addCol}>+ 列</button>
                <button className="btn sm ghost" onClick={() => exportTableCSV(table!.header, table!.rows, `${active.title}.csv`)}>导出 CSV</button>
                <button className="btn sm ghost" onClick={() => void exportTableXLSX([{ name: active.title, header: table!.header, rows: table!.rows }], `${active.title}.xlsx`)}>导出 XLSX</button>
              </>
            ) : (
              <div className="seg">
                {([['edit', '编辑'], ['split', '分栏'], ['view', '预览']] as const).map(([k, l]) => (
                  <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
                ))}
              </div>
            )}
          </div>

          {isTable && table ? (
            <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
              <table className="mdtable" style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: 44 }} className="small faint">#</th>
                    {table.header.map((h, ci) => (
                      <th key={ci}>
                        <input
                          className="input"
                          style={{ border: 0, background: 'transparent', fontWeight: 600, padding: 2 }}
                          value={h}
                          onChange={(e) => drafts.edit(active.id, { headers: { [ci]: e.currentTarget.value } })}
                          onBlur={blur}
                          onCompositionStart={() => drafts.pause(active.id, true)}
                          onCompositionEnd={() => drafts.pause(active.id, false)}
                        />
                      </th>
                    ))}
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {rowsView.slice(rowStart, rowStart + MAX_RENDER_ROWS).map((r, index) => {
                    const ri = rowStart + index;
                    return (
                    <tr key={ri}>
                      <td className="small faint">{ri + 1}</td>
                      {table.header.map((_, ci) => (
                        <td key={ci} style={{ padding: 0 }}>
                          <input
                            className="input"
                            style={{ border: 0, background: 'transparent', padding: '4px 6px', borderRadius: 0 }}
                            value={r[ci] ?? ''}
                            onChange={(e) => drafts.edit(active.id, { cells: { [`${ri}:${ci}`]: { row: ri, column: ci, value: e.currentTarget.value } } })}
                            onBlur={blur}
                            onCompositionStart={() => drafts.pause(active.id, true)}
                            onCompositionEnd={() => drafts.pause(active.id, false)}
                          />
                        </td>
                      ))}
                      <td>
                        <button className="iconbtn" onClick={() => delRow(ri)}>🗑</button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {rowsView.length > MAX_RENDER_ROWS && (
                <div className="small faint" style={{ padding: 8 }}>
                  <button className="btn sm" disabled={page === 0} onClick={() => setTablePage(page - 1)}>上一页</button>
                  {' '}{page + 1} / {pageCount} 页 · 第 {rowStart + 1}–{Math.min(rowStart + MAX_RENDER_ROWS, rowsView.length)} 行，共 {rowsView.length} 行{' '}
                  <button className="btn sm" disabled={page + 1 >= pageCount} onClick={() => setTablePage(page + 1)}>下一页</button>
                </div>
              )}
              {!rowsView.length && <div className="small faint" style={{ padding: 12 }}>还没有数据行，点「+ 行」开始</div>}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: tab === 'split' ? '1fr 1fr' : '1fr', flex: 1, minHeight: 0 }}>
              {tab !== 'view' && (
                <textarea
                  className="input"
                  style={{ border: 0, borderRadius: 0, minHeight: 420, fontFamily: 'var(--mono)', fontSize: 13 }}
                  value={active.content}
                  onChange={(e) => drafts.edit(active.id, { content: e.currentTarget.value })}
                  onBlur={blur}
                  onCompositionStart={() => drafts.pause(active.id, true)}
                  onCompositionEnd={() => drafts.pause(active.id, false)}
                />
              )}
              {tab !== 'edit' && (
                <div
                  style={{
                    padding: 16, overflow: 'auto', lineHeight: 1.8,
                    borderLeft: tab === 'split' ? '1px solid var(--border)' : undefined,
                  }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
            </div>
          )}

          <div className="ft small faint">
            最后更新 {formatDate(active.updatedAt)}
            {isTable ? ` · ${table?.rows.length ?? 0} 行 × ${table?.header.length ?? 0} 列` : ' · 支持 # 标题、- 列表、**粗体**、`代码`、表格'}
          </div>
        </div>
      )}
      {confirmNode}
    </div>
  );
}
