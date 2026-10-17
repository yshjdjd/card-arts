import type { ProjectDocument } from './types';

export interface DocumentPatch {
  title?: string;
  content?: string;
  headers?: Record<string, string>;
  cells?: Record<string, { row: number; column: number; value: string }>;
}
type Entry = {
  overlay: DocumentPatch;
  pending: DocumentPatch;
  saving?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  paused: boolean;
  error?: string;
};
const empty = (p: DocumentPatch) => p.title === undefined && p.content === undefined
  && !Object.keys(p.headers ?? {}).length && !Object.keys(p.cells ?? {}).length;
const merge = (a: DocumentPatch, b: DocumentPatch): DocumentPatch => ({
  ...a, ...b, headers: { ...a.headers, ...b.headers }, cells: { ...a.cells, ...b.cells },
});

/** Apply only changed fields: editing a cell must not overwrite another cell's newer value. */
export function applyDocumentPatch(doc: ProjectDocument, patch: DocumentPatch): void {
  const table = doc.table;
  if (doc.kind === 'table' && patch.content !== undefined) throw new Error('表格正文由表格数据生成');
  for (const index of Object.keys(patch.headers ?? {})) {
    if (!table || !Number.isInteger(+index) || +index < 0 || +index >= table.header.length) throw new Error('表格列已变化，请检查草稿');
  }
  for (const cell of Object.values(patch.cells ?? {})) {
    if (!table || !Number.isInteger(cell.row) || !Number.isInteger(cell.column)
      || cell.row < 0 || cell.row >= table.rows.length || cell.column < 0 || cell.column >= table.header.length) throw new Error('表格结构已变化，请检查草稿');
  }
  if (patch.title !== undefined) doc.title = patch.title;
  if (patch.content !== undefined) doc.content = patch.content;
  for (const [index, value] of Object.entries(patch.headers ?? {})) table!.header[+index] = value;
  for (const cell of Object.values(patch.cells ?? {})) table!.rows[cell.row][cell.column] = cell.value;
}

/** Local controlled-input state with debounced, serialized, per-document persistence. */
export class DocumentDrafts {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(private save: (id: string, patch: DocumentPatch) => Promise<void>, private delay = 700) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private publish() { this.version++; for (const listener of this.listeners) listener(); }
  private entry(id: string) {
    let value = this.entries.get(id);
    if (!value) { value = { overlay: {}, pending: {}, paused: false }; this.entries.set(id, value); }
    return value;
  }
  private schedule(id: string, entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.paused) entry.timer = setTimeout(() => { void this.flush(id); }, this.delay);
  }
  edit(id: string, patch: DocumentPatch) {
    const entry = this.entry(id);
    entry.overlay = merge(entry.overlay, patch);
    entry.pending = merge(entry.pending, patch);
    entry.error = undefined;
    this.schedule(id, entry);
    this.publish();
  }
  pause(id: string, paused: boolean) {
    const entry = this.entry(id);
    entry.paused = paused;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!paused && !empty(entry.pending)) this.schedule(id, entry);
  }
  view(doc: ProjectDocument): ProjectDocument {
    const overlay = this.entries.get(doc.id)?.overlay;
    if (!overlay || empty(overlay)) return doc;
    const copy = { ...doc, table: doc.table ? { ...doc.table, header: [...doc.table.header], rows: doc.table.rows.map((r) => [...r]) } : undefined };
    // A structural change from another editor must not crash this page; flush will report it.
    const safe = { ...overlay, headers: Object.fromEntries(Object.entries(overlay.headers ?? {}).filter(([i]) => copy.table && +i < copy.table.header.length)),
      cells: Object.fromEntries(Object.entries(overlay.cells ?? {}).filter(([, c]) => copy.table && c.row < copy.table.rows.length && c.column < copy.table.header.length)) };
    applyDocumentPatch(copy, safe);
    return copy;
  }
  /** Drop acknowledged overlays only; an older save cannot erase newer typing. */
  reconcile(docs: ProjectDocument[]) {
    let changed = false;
    for (const doc of docs) {
      const entry = this.entries.get(doc.id);
      if (!entry) continue;
      const overlay = entry.overlay;
      for (const key of ['title', 'content'] as const) {
        if (overlay[key] !== undefined && overlay[key] === doc[key]) { delete overlay[key]; changed = true; }
      }
      for (const [index, value] of Object.entries(overlay.headers ?? {})) {
        if (doc.table?.header[+index] === value) { delete overlay.headers![index]; changed = true; }
      }
      for (const [key, cell] of Object.entries(overlay.cells ?? {})) {
        if (doc.table?.rows[cell.row]?.[cell.column] === cell.value) { delete overlay.cells![key]; changed = true; }
      }
    }
    if (changed) this.publish();
  }
  status(id: string): 'saved' | 'pending' | 'saving' | 'error' {
    const entry = this.entries.get(id);
    return entry?.error ? 'error' : entry?.saving ? 'saving' : entry && !empty(entry.pending) ? 'pending' : 'saved';
  }
  error(id: string) { return this.entries.get(id)?.error; }
  hasUnsaved() { return [...this.entries.values()].some((e) => !empty(e.pending) || !!e.saving); }
  async flush(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.saving) {
      const success = await entry.saving;
      return success ? this.flush(id) : false;
    }
    if (entry.paused) return false;
    if (empty(entry.pending)) return true;
    // Immutable snapshot, independent of DOM events and all later keystrokes.
    const patch = entry.pending;
    entry.pending = {};
    const saving = Promise.resolve().then(() => this.save(id, patch)).then(() => {
      entry.error = undefined;
      return true;
    }, (error) => {
      entry.pending = merge(patch, entry.pending);
      entry.error = (error as Error).message || '保存失败';
      return false;
    });
    entry.saving = saving;
    this.publish();
    const success = await saving;
    entry.saving = undefined;
    this.publish();
    if (success && !empty(entry.pending) && !entry.paused) return this.flush(id);
    return success;
  }
  async flushAll() {
    for (const entry of this.entries.values()) entry.paused = false;
    return (await Promise.all([...this.entries.keys()].map((id) => this.flush(id)))).every(Boolean);
  }
  discard(id: string) {
    const entry = this.entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
    this.publish();
  }
}
