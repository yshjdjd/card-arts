import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const built = await build({ entryPoints: [fileURLToPath(new URL('./src/lib/documentDrafts.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false });
const { DocumentDrafts, applyDocumentPatch } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const doc = (id = 'a') => ({ id, title: '原名', content: '原文', createdAt: '', updatedAt: '' });
const tick = () => new Promise((r) => setTimeout(r, 15));

test('typing is immediately visible without writes; flush coalesces a whole burst', async () => {
  const saved = [];
  const drafts = new DocumentDrafts(async (id, patch) => saved.push({ id, patch }), 10000);
  const original = doc();
  drafts.edit('a', { content: '中' });
  drafts.edit('a', { content: '中文' });
  drafts.edit('a', { title: '新标题' });
  assert.equal(drafts.view(original).content, '中文');
  assert.equal(drafts.view(original).title, '新标题');
  assert.equal(original.content, '原文');
  assert.equal(saved.length, 0); assert.equal(drafts.status('a'), 'pending');
  assert.equal(await drafts.flush('a'), true);
  assert.equal(saved.length, 1); assert.equal(saved[0].patch.content, '中文');
  assert.equal(drafts.status('a'), 'saved');
});

test('a slow older save never erases newer typing, and writes remain serialized', async () => {
  const saved = [];
  let release;
  const gate = new Promise((r) => release = r);
  const drafts = new DocumentDrafts(async (_, patch) => { saved.push(patch); if (saved.length === 1) await gate; }, 10000);
  drafts.edit('a', { content: 'first' });
  const saving = drafts.flush('a');
  await Promise.resolve();
  drafts.edit('a', { content: 'second' });
  drafts.reconcile([{ ...doc(), content: 'first' }]);
  assert.equal(drafts.view(doc()).content, 'second');
  assert.equal(saved.length, 1);
  release();
  assert.equal(await saving, true);
  assert.deepEqual(saved.map((x) => x.content), ['first', 'second']);
  assert.equal(drafts.view(doc()).content, 'second');
});

test('document switches preserve separate targets and page cleanup flushes every draft', async () => {
  const saved = [];
  const drafts = new DocumentDrafts(async (id, patch) => saved.push([id, patch.content]), 10000);
  drafts.edit('a', { content: 'A new' }); drafts.edit('b', { content: 'B new' });
  assert.equal(drafts.view(doc('a')).content, 'A new');
  assert.equal(drafts.view(doc('b')).content, 'B new');
  assert.equal(await drafts.flushAll(), true);
  assert.deepEqual(saved.sort(), [['a', 'A new'], ['b', 'B new']]);
  assert.equal(drafts.hasUnsaved(), false);
});

test('failed saves keep the latest local draft and can retry without losing edits', async () => {
  let fail = true, result;
  const drafts = new DocumentDrafts(async (_, patch) => { if (fail) throw new Error('disk full'); result = patch; }, 10000);
  drafts.edit('a', { content: 'unsaved' });
  assert.equal(await drafts.flush('a'), false);
  assert.equal(drafts.status('a'), 'error'); assert.equal(drafts.error('a'), 'disk full');
  assert.equal(drafts.view(doc()).content, 'unsaved'); assert.equal(drafts.hasUnsaved(), true);
  drafts.edit('a', { content: 'latest' }); fail = false;
  assert.equal(await drafts.flush('a'), true);
  assert.equal(result.content, 'latest');
});

test('Chinese composition pauses autosave, and final composition resumes it', async () => {
  let saves = 0;
  const drafts = new DocumentDrafts(async () => { saves++; }, 1);
  drafts.pause('a', true); drafts.edit('a', { content: '拼音输入中' });
  await tick(); assert.equal(saves, 0);
  drafts.pause('a', false); await tick(); assert.equal(saves, 1);
  drafts.pause('b', true); drafts.edit('b', { content: '离开时仍有草稿' });
  await drafts.flushAll(); assert.equal(saves, 2);
});

test('saved fields stop shadowing external edits once the database acknowledges them', async () => {
  const drafts = new DocumentDrafts(async () => {}, 10000);
  drafts.edit('a', { content: 'saved' }); await drafts.flush('a');
  drafts.reconcile([{ ...doc(), content: 'saved' }]);
  assert.equal(drafts.view({ ...doc(), content: 'agent update' }).content, 'agent update');
  drafts.edit('a', { title: 'new name' });
  assert.equal(drafts.view({ ...doc(), content: 'agent update' }).content, 'agent update');
  await drafts.flushAll();
});

test('cell patches preserve other cells, work beyond row 300, and fill short imported rows', () => {
  const table = { ...doc(), kind: 'table', table: { header: ['A', 'B'], rows: Array.from({ length: 350 }, () => ['old']) } };
  table.table.rows[320] = ['external', 'keep'];
  applyDocumentPatch(table, { cells: { '320:1': { row: 320, column: 1, value: 'new' }, '321:1': { row: 321, column: 1, value: 'added' } } });
  assert.deepEqual(table.table.rows[320], ['external', 'new']);
  assert.deepEqual(table.table.rows[321], ['old', 'added']);
  assert.throws(() => applyDocumentPatch(table, { title: 'must not change', cells: { bad: { row: 999, column: 0, value: 'bad' } } }), /结构已变化/);
  assert.equal(table.title, '原名');
});

test('editing a table header also uses local drafts and commits immutable values', async () => {
  const table = { ...doc(), kind: 'table', table: { header: ['A'], rows: [['old']] } };
  let saved;
  const drafts = new DocumentDrafts(async (_, patch) => { saved = patch; }, 10000);
  drafts.edit('a', { headers: { 0: '名称' }, cells: { '0:0': { row: 0, column: 0, value: '新值' } } });
  assert.equal(drafts.view(table).table.header[0], '名称'); assert.equal(table.table.header[0], 'A');
  await drafts.flush('a'); applyDocumentPatch(table, saved); drafts.reconcile([table]);
  table.table.rows[0][0] = 'external';
  assert.equal(drafts.view(table).table.rows[0][0], 'external');
});
