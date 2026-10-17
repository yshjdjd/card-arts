import type { LayoutElement } from './types';
export interface Box { x: number; y: number; width: number; height: number }
export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export function bounds(elements: Box[]): Box {
  if (!elements.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...elements.map((e) => e.x)), y = Math.min(...elements.map((e) => e.y));
  return { x, y, width: Math.max(...elements.map((e) => e.x + e.width)) - x, height: Math.max(...elements.map((e) => e.y + e.height)) - y };
}
export function hitElement(element: LayoutElement, x: number, y: number) {
  const cx = element.x + element.width / 2, cy = element.y + element.height / 2;
  const a = -(element.rotation || 0) * Math.PI / 180;
  const dx = x - cx, dy = y - cy;
  return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= element.width / 2 && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= element.height / 2;
}
export function selectionIds(elements: LayoutElement[], ids: string[]): string[] {
  const groups = new Set(elements.filter((e) => ids.includes(e.id) && e.groupId).map((e) => e.groupId));
  return elements.filter((e) => !e.locked && !e.hidden && (ids.includes(e.id) || (e.groupId && groups.has(e.groupId)))).map((e) => e.id);
}
export function transformElements(elements: LayoutElement[], from: Box, to: Box): LayoutElement[] {
  const sx = to.width / Math.max(1, from.width), sy = to.height / Math.max(1, from.height);
  return elements.map((e) => ({ ...e, x: to.x + (e.x - from.x) * sx, y: to.y + (e.y - from.y) * sy,
    width: Math.max(1, e.width * sx), height: Math.max(1, e.height * sy) }));
}
export function resizedRotated(element: LayoutElement, dx: number, dy: number, handle: string, keepRatio = false): LayoutElement {
  const angle = (element.rotation || 0) * Math.PI / 180;
  const lx = dx * Math.cos(angle) + dy * Math.sin(angle), ly = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const signX = handle.endsWith('r') ? 1 : -1, signY = handle.startsWith('b') ? 1 : -1;
  const width = Math.max(8, element.width + lx * signX);
  const height = keepRatio ? element.height * width / Math.max(1, element.width) : Math.max(8, element.height + ly * signY);
  const cx = (width - element.width) / 2 * signX, cy = (height - element.height) / 2 * signY;
  return { ...element, width, height, x: element.x + element.width / 2 + cx * Math.cos(angle) - cy * Math.sin(angle) - width / 2,
    y: element.y + element.height / 2 + cx * Math.sin(angle) + cy * Math.cos(angle) - height / 2 };
}
function alignedBoxes(elements: LayoutElement[], mode: Alignment, frame = bounds(elements)): LayoutElement[] {
  return elements.map((e) => ({ ...e,
    x: mode === 'left' ? frame.x : mode === 'center' ? frame.x + (frame.width - e.width) / 2 : mode === 'right' ? frame.x + frame.width - e.width : e.x,
    y: mode === 'top' ? frame.y : mode === 'middle' ? frame.y + (frame.height - e.height) / 2 : mode === 'bottom' ? frame.y + frame.height - e.height : e.y,
  }));
}
function distributedBoxes(elements: LayoutElement[], axis: 'x' | 'y'): LayoutElement[] {
  if (elements.length < 3) return elements;
  const dim = axis === 'x' ? 'width' : 'height';
  const sorted = [...elements].sort((a, b) => a[axis] - b[axis]);
  const end = sorted.at(-1)![axis] + sorted.at(-1)![dim];
  const gap = (end - sorted[0][axis] - sorted.reduce((n, e) => n + e[dim], 0)) / (sorted.length - 1);
  let position = sorted[0][axis];
  const positions = new Map(sorted.map((e) => { const value = position; position += e[dim] + gap; return [e.id, value]; }));
  return elements.map((e) => ({ ...e, [axis]: positions.get(e.id)! }));
}
function units(elements: LayoutElement[]) {
  const map = new Map<string, LayoutElement[]>();
  for (const el of elements) { const key = el.groupId ? `group:${el.groupId}` : `element:${el.id}`; map.set(key, [...(map.get(key) || []), el]); }
  return [...map].map(([id, children]) => ({ id, children, box: { ...children[0], ...bounds(children), id } }));
}
export function selectionUnitCount(elements: LayoutElement[]) { return units(elements).length; }
function arrangeUnits(elements: LayoutElement[], arrange: (boxes: LayoutElement[]) => LayoutElement[]) {
  const groups = units(elements);
  const placed = new Map(arrange(groups.map((u) => u.box)).map((e) => [e.id, e]));
  const next = new Map<string, LayoutElement>();
  for (const group of groups) {
    const position = placed.get(group.id)!;
    for (const child of group.children) next.set(child.id, { ...child, x: child.x + position.x - group.box.x, y: child.y + position.y - group.box.y });
  }
  return elements.map((e) => next.get(e.id)!);
}
export function aligned(elements: LayoutElement[], mode: Alignment, frame?: Box): LayoutElement[] {
  return arrangeUnits(elements, (boxes) => alignedBoxes(boxes, mode, frame));
}
export function distributed(elements: LayoutElement[], axis: 'x' | 'y'): LayoutElement[] {
  return arrangeUnits(elements, (boxes) => distributedBoxes(boxes, axis));
}
export function snapped(box: Box, targets: Box[], threshold: number): { box: Box; guides: { axis: 'x' | 'y'; value: number }[] } {
  const result = { ...box }, guides: { axis: 'x' | 'y'; value: number }[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dim = axis === 'x' ? 'width' : 'height';
    let best = threshold + 1, shift = 0, guide = 0;
    for (const target of targets) for (const a of [0, 0.5, 1]) for (const b of [0, 0.5, 1]) {
      const value = target[axis] + target[dim] * b;
      const delta = value - (box[axis] + box[dim] * a);
      if (Math.abs(delta) < best) { best = Math.abs(delta); shift = delta; guide = value; }
    }
    if (best <= threshold) { result[axis] += shift; guides.push({ axis, value: guide }); }
  }
  return { box: result, guides };
}
export function cropRect(iw: number, ih: number, frame: Box, fit: 'cover' | 'contain', zoom = 1, focusX = 0.5, focusY = 0.5): Box {
  const ratio = (fit === 'cover' ? Math.max : Math.min)(frame.width / Math.max(1, iw), frame.height / Math.max(1, ih)) * Math.max(1, zoom);
  const width = iw * ratio, height = ih * ratio;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return { x: frame.x + (frame.width - width) * clamp(focusX), y: frame.y + (frame.height - height) * clamp(focusY), width, height };
}
export function fitZoom(width: number, height: number, containerWidth: number, containerHeight: number) {
  return Math.max(0.05, Math.min(3, (containerWidth - 80) / Math.max(1, width), (containerHeight - 80) / Math.max(1, height)));
}
