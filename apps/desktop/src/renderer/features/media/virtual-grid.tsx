// A grid that draws only the rows near the scroll viewport (A4: a library of a few thousand
// files no longer mounts a few thousand tiles). The scroll container is the page's; the grid
// measures its width and its distance from the container's top.
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { gridWindow } from "../../lib/virtual-grid.ts";

export function VirtualGrid<T>({
  items,
  scrollRef,
  minColumn,
  columnGap,
  rowGap,
  aspect,
  extra,
  label,
  keyOf,
  render,
}: {
  items: readonly T[];
  scrollRef: RefObject<HTMLElement | null>;
  minColumn: number;
  columnGap: number;
  rowGap: number;
  aspect: number;
  extra: number;
  label: string;
  keyOf(item: T): string;
  render(item: T): ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, scrollTop: 0, viewport: 0 });

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    if (!grid || !scroller) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top =
        grid.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setFrame((f) => {
        const next = {
          width: grid.clientWidth,
          scrollTop: scroller.scrollTop - top,
          viewport: scroller.clientHeight,
        };
        return f.width === next.width &&
          f.scrollTop === next.scrollTop &&
          f.viewport === next.viewport
          ? f
          : next;
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    observer.observe(scroller);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scrollRef]);

  const win = gridWindow({
    count: items.length,
    width: frame.width,
    minColumn,
    columnGap,
    rowGap,
    aspect,
    extra,
    scrollTop: frame.scrollTop,
    viewport: frame.viewport,
  });
  return (
    <div ref={gridRef} style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
      <section
        aria-label={label}
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${frame.width > 0 ? win.columns : "auto-fill"}, minmax(${frame.width > 0 ? 0 : minColumn}px, 1fr))`,
          columnGap,
          rowGap,
        }}
      >
        {items.slice(win.start, win.end).map((item) => (
          <div key={keyOf(item)} className="min-w-0">
            {render(item)}
          </div>
        ))}
      </section>
    </div>
  );
}
