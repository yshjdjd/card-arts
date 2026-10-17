import React from 'react';
import type { AnyCondition, Condition, ConditionGroup, CompareOp, Field } from '../../lib/types';
import { Select } from '../../components/ui';
import { uid } from '../../lib/utils';

const OPS: { value: CompareOp; label: string }[] = [
  { value: 'equals', label: '等于' },
  { value: 'notEquals', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'contains', label: '包含' },
  { value: 'isEmpty', label: '为空' },
  { value: 'isNotEmpty', label: '不为空' },
];

const VALUELESS: CompareOp[] = ['isEmpty', 'isNotEmpty'];

export function describe(cond: AnyCondition | undefined, fields: Field[]): string {
  if (!cond) return '始终显示';
  if (cond.type === 'group') {
    const join = cond.operator === 'all' ? ' 且 ' : ' 或 ';
    return `(${cond.conditions.map((c) => describe(c, fields)).join(join)})`;
  }
  const f = fields.find((x) => x.id === cond.fieldId);
  const op = OPS.find((o) => o.value === cond.operator)?.label ?? cond.operator;
  return VALUELESS.includes(cond.operator)
    ? `${f?.name ?? cond.fieldId} ${op}`
    : `${f?.name ?? cond.fieldId} ${op} ${String(cond.value ?? '')}`;
}

export default function ConditionEditor({
  value, fields, onChange,
}: {
  value: AnyCondition | undefined;
  fields: Field[];
  onChange: (c: AnyCondition | undefined) => void;
}) {
  const setMode = (mode: 'none' | 'comparison' | 'group') => {
    if (mode === 'none') return onChange(undefined);
    if (mode === 'comparison') {
      return onChange({
        type: 'comparison',
        fieldId: fields[0]?.id ?? '',
        operator: 'equals',
        value: '',
      } as Condition);
    }
    return onChange({ type: 'group', operator: 'all', conditions: [] } as ConditionGroup);
  };

  const mode: 'none' | 'comparison' | 'group' = !value ? 'none' : value.type;

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <Select
          value={mode}
          onChange={(v) => setMode(v as 'none' | 'comparison' | 'group')}
          options={[
            { value: 'none', label: '始终显示' },
            { value: 'comparison', label: '单一条件' },
            { value: 'group', label: '条件组' },
          ]}
        />
      </div>

      {value?.type === 'comparison' && (
        <ComparisonRow cond={value} fields={fields} onChange={onChange} depth={0} />
      )}

      {value?.type === 'group' && (
        <GroupBlock group={value} fields={fields} onChange={onChange} depth={0} />
      )}
    </div>
  );
}

function ComparisonRow({
  cond, fields, onChange, depth, onRemove,
}: {
  cond: Condition; fields: Field[];
  onChange: (c: AnyCondition) => void;
  depth: number; onRemove?: () => void;
}) {
  const f = fields.find((x) => x.id === cond.fieldId);
  const patch = (p: Partial<Condition>) => onChange({ ...cond, ...p } as Condition);

  return (
    <div style={{ border: depth ? '1px solid var(--border)' : undefined, borderRadius: 6, padding: depth ? 8 : 0 }}>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <select className="select" style={{ flex: 1 }} value={cond.fieldId} onChange={(e) => patch({ fieldId: e.target.value, value: '' })}>
          <option value="">选择字段</option>
          {fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className="select" style={{ width: 108 }} value={cond.operator} onChange={(e) => patch({ operator: e.target.value as CompareOp })}>
          {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {onRemove && <button className="iconbtn" onClick={onRemove}>🗑</button>}
      </div>
      {!VALUELESS.includes(cond.operator) && (
        <div>
          {f?.type === 'select' ? (
            <select className="select" value={String(cond.value ?? '')} onChange={(e) => patch({ value: e.target.value })}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : f?.type === 'boolean' ? (
            <select className="select" value={String(cond.value ?? '')} onChange={(e) => patch({ value: e.target.value === 'true' })}>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <input
              className="input"
              value={String(cond.value ?? '')}
              inputMode={f?.type === 'number' ? 'decimal' : 'text'}
              onChange={(e) => patch({ value: f?.type === 'number' ? Number(e.target.value || 0) : e.target.value })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function GroupBlock({
  group, fields, onChange, depth, onRemove,
}: {
  group: ConditionGroup; fields: Field[];
  onChange: (c: AnyCondition) => void;
  depth: number; onRemove?: () => void;
}) {
  const items = group.conditions ?? [];
  const setItems = (next: AnyCondition[]) => onChange({ ...group, conditions: next } as ConditionGroup);

  return (
    <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 8, padding: 8 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <Select
          value={group.operator}
          onChange={(v) => onChange({ ...group, operator: v } as ConditionGroup)}
          options={[{ value: 'all', label: '同时满足' }, { value: 'any', label: '任一满足' }]}
        />
        <span style={{ flex: 1 }} />
        {onRemove && <button className="iconbtn" onClick={onRemove}>🗑</button>}
      </div>

      {items.map((c, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          {c.type === 'group' ? (
            <GroupBlock
              group={c} fields={fields} depth={depth + 1}
              onChange={(nc) => setItems(items.map((x, j) => (j === i ? nc : x)))}
              onRemove={() => setItems(items.filter((_, j) => j !== i))}
            />
          ) : (
            <ComparisonRow
              cond={c} fields={fields} depth={depth + 1}
              onChange={(nc) => setItems(items.map((x, j) => (j === i ? nc : x)))}
              onRemove={() => setItems(items.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}

      <div className="row">
        <button
          className="btn sm"
          onClick={() =>
            setItems([
              ...items,
              { type: 'comparison', fieldId: fields[0]?.id ?? '', operator: 'equals', value: '' } as Condition,
            ])
          }
        >+ 条件</button>
        {depth < 2 && (
          <button
            className="btn sm"
            onClick={() => setItems([...items, { type: 'group', operator: 'all', conditions: [] } as ConditionGroup])}
          >+ 条件组</button>
        )}
      </div>
    </div>
  );
}

export function newGroup(): ConditionGroup {
  return { type: 'group', operator: 'all', conditions: [] };
}

export function newComparison(fieldId: string): Condition {
  return { type: 'comparison', fieldId, operator: 'equals', value: '' };
}

void uid;
