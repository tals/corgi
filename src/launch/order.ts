import type { Row } from "./row";

/** Unknown or removed rows don't affect the order; new rows follow known ones. */
export function arrange(rows: readonly Row[], order: readonly Row[]): Row[] {
  const remaining = new Set(rows);
  const out: Row[] = [];
  for (const row of order) if (remaining.delete(row)) out.push(row);
  return [...out, ...remaining];
}
export function move(order: readonly Row[], row: Row, before: Row | null): Row[] {
  if (row === before) return [...order];
  const out = order.filter(r => r !== row),
    index = before === null ? -1 : out.indexOf(before);
  out.splice(index < 0 ? out.length : index, 0, row);
  return out;
}
