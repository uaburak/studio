import type { Page } from "@studio/contract";

/**
 * Keyset pagination helpers. Lists fetch `limit + 1` rows; the extra row only
 * tells us whether another page exists. Cursors are opaque to clients.
 */
export function toPage<Row, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
  cursorOf: (row: Row) => string,
): Page<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toItem),
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
}

/** Composite cursor `(ms, id)` for lists ordered by a timestamp column, e.g. schedules. */
export function encodeTimeCursor(ms: number, id: string): string {
  return `${ms.toString(36)}.${id}`;
}

export function decodeTimeCursor(cursor: string): { ms: number; id: string } | null {
  const dot = cursor.indexOf(".");
  if (dot <= 0) return null;
  const ms = Number.parseInt(cursor.slice(0, dot), 36);
  const id = cursor.slice(dot + 1);
  return Number.isFinite(ms) && id ? { ms, id } : null;
}
