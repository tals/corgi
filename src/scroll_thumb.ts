//! The scrollbar thumb a list draws over its border while its rows overflow.

/** The thumb's rows within a `track` rows tall that shows `total` rows from
 * row `first`; null while every row fits. */
export function thumb(track: number, total: number, first: number): { start: number; len: number } | null {
  if (total <= track || track < 1) return null;
  const len = Math.max(1, Math.floor((track * track) / total));
  return { start: Math.floor(((track - len) * first) / (total - track)), len };
}
