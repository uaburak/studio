// Which tiles of a long grid to draw (A4): the rows inside the scroll viewport plus a few above
// and below; the others are stood in for by padding of the same height. Tiles are a fixed shape
// (`aspect` × column width + `extra` px of caption), so a row's height follows from the width.

export interface GridMetrics {
  /** Tiles in the grid. */
  count: number;
  /** The grid's own width (px). */
  width: number;
  /** Narrowest column (CSS `minmax(<min>, 1fr)`). */
  minColumn: number;
  columnGap: number;
  rowGap: number;
  /** Tile height / column width (1 = square). */
  aspect: number;
  /** Fixed height under the picture (caption). */
  extra: number;
  /** The viewport's top, measured from the grid's top (negative: the grid starts lower). */
  scrollTop: number;
  viewport: number;
  /** Rows drawn beyond the viewport on each side. */
  overscan?: number;
}

export interface GridWindow {
  columns: number;
  rowHeight: number;
  /** Tiles `start` (inclusive) .. `end` (exclusive) are drawn. */
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

export function gridWindow(m: GridMetrics): GridWindow {
  const columns = Math.max(1, Math.floor((m.width + m.columnGap) / (m.minColumn + m.columnGap)));
  const columnWidth = (m.width - m.columnGap * (columns - 1)) / columns;
  const rowHeight = Math.max(1, columnWidth * m.aspect + m.extra);
  const stride = rowHeight + m.rowGap;
  const rows = Math.ceil(m.count / columns);
  // Not laid out yet (width 0, tests): everything.
  if (m.width <= 0 || m.viewport <= 0 || rows === 0) {
    return { columns, rowHeight, start: 0, end: m.count, padTop: 0, padBottom: 0 };
  }
  const overscan = m.overscan ?? 2;
  const first = Math.max(0, Math.floor(Math.max(0, m.scrollTop) / stride) - overscan);
  const last = Math.min(
    rows - 1,
    Math.max(first, Math.ceil((m.scrollTop + m.viewport) / stride) + overscan),
  );
  return {
    columns,
    rowHeight,
    start: first * columns,
    end: Math.min(m.count, (last + 1) * columns),
    padTop: first * stride,
    padBottom: Math.max(0, (rows - last - 1) * stride),
  };
}
