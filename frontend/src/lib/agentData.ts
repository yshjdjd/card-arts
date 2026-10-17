/** Unique target resolution. An ambiguous name must never silently select the first item. */
export function selectEntity<T>(items: T[], hint: unknown, id: (item: T) => string, name: (item: T) => string, allowSingle = false): T | undefined {
  const h = String(hint ?? '').trim();
  if (!h) return allowSingle && items.length === 1 ? items[0] : undefined;
  const byId = items.find((item) => id(item) === h);
  if (byId) return byId;
  const unique = (hits: T[]) => {
    if (hits.length > 1) throw new Error(`目标「${h}」匹配多个对象，请使用精确 id：${hits.slice(0, 8).map((x) => `${name(x)} [id=${id(x)}]`).join('、')}`);
    return hits[0];
  };
  const exact = unique(items.filter((item) => name(item) === h));
  if (exact) return exact;
  // Explicit numeric positions precede fuzzy name matching.
  const index = Number(h);
  if (Number.isInteger(index) && index >= 1 && index <= items.length) return items[index - 1];
  return unique(items.filter((item) => name(item) && (name(item).includes(h) || h.includes(name(item)))));
}

export function textPage(body: string, offsetValue?: unknown, limitValue?: unknown): string {
  const number = (value: unknown, fallback: number) => value === undefined || !Number.isFinite(Number(value)) ? fallback : Math.floor(Number(value));
  const offset = Math.max(0, Math.min(body.length, number(offsetValue, 0)));
  const limit = Math.max(1, Math.min(3000, number(limitValue, 2500)));
  const end = Math.min(body.length, offset + limit);
  return `字符区间 ${offset}..${end} / ${body.length}；nextOffset=${end < body.length ? end : 'null'}\n${body.slice(offset, end)}`;
}
